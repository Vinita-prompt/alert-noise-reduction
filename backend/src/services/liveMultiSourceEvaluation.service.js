const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const appDynamicsService = require('./appDynamics.service');
const grafanaService = require('./grafanaDashboard.service');
const nagiosService = require('./nagios.service');
const thousandEyesRuntimeService = require('./thousandEyes.service');
const { workspaceService: thousandEyesWorkspaceService } = require('./thousandEyesWorkspace.service');
const { service: operationsReadService } = require('./atlassian/opsReadValidation.service');
const { service: learningDatasetService } = require('./historicalLearningDataset.service');
const { service: operationalOutcomeService } = require('./operationalOutcome.service');
const {
  createSourceEvidenceAdapterRegistry,
  normalizeOperationsAlert,
} = require('./sourceEvidenceAdapters.service');
const { extractDeepLinkIdentity } = require('./sourceIdentity.service');
const {
  buildSourceEvidenceCoverage,
  coverageFromStored,
} = require('./sourceEvidenceCoverage.service');
const {
  DECISION_CONFIDENCE,
  DECISION_POLICY_VERSION,
  EVALUATION_STATUS,
  evaluateUnifiedEvidence,
  prioritySignal,
} = require('./unifiedEvidenceDecision.service');
const {
  buildMonitoringLifecycle,
  loadHistoricalProfile,
} = require('./monitoringLifecycleEvidence.service');
const { service: alertEpisodeService } = require('./alertEpisode.service');
const {
  loadOccurrenceObservation,
  mergeOccurrenceEvidence,
  occurrenceEvidenceFreshness,
} = require('./occurrenceEvidenceConsumption.service');
const { service: mlShadowService } = require('./mlShadow.service');
const { service: humanVerificationService } = require('./humanVerification.service');
const { service: evidenceLearningService } = require('./evidenceLearning.service');
const {
  COMMAND_CENTER_TEAM,
  commandCenterAlertSql,
} = require('./commandCenterEligibility.service');

const migrationSql = [
  '042_live_multi_source_shadow_evaluation.sql',
  '043_unified_evidence_decision.sql',
  '044_gold_review_feedback.sql',
  '045_phase12_exhaustive_results.sql',
  '046_phase13_decision_quality.sql',
  '047_phase14_monitoring_lifecycle.sql',
  '048_episode_based_shadow_evaluation.sql',
  '049_appdynamics_source_evidence.sql',
  '050_grafana_source_evidence.sql',
  '051_nagios_source_evidence.sql',
  '052_grafana_loki_lifecycle.sql',
  '053_live_occurrence_grouping.sql',
].map((fileName) => fs.readFileSync(path.join(__dirname, `../db/migrations/${fileName}`), 'utf8')).join('\n');

const SUPPORTED_SOURCES = Object.freeze(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);
const RELEASE_STATUS = 'NOT_READY';
const MODEL_VERSION = 'NO_APPROVED_MODEL';
const MINIMUM_PERFORMANCE_LABELS = 30;
const GOLD_REVIEW_NOISE_REASONS = Object.freeze([
  'DUPLICATE', 'FLAPPING', 'AUTO_RESOLVED', 'NON_ACTIONABLE',
  'CORRELATED', 'STALE', 'EXPECTED_ACTIVITY', 'OTHER',
]);
const GOLD_REVIEW_UNKNOWN_REASONS = Object.freeze([
  'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE',
  'OPERATIONAL_OUTCOME_UNCLEAR', 'OTHER',
]);
const EVALUATION_TIMEOUT_MS = 12_000;
const APPDYNAMICS_EVALUATION_TIMEOUT_MS = Math.max(12_000, Number(process.env.APPDYNAMICS_EVALUATION_TIMEOUT_MS || 30_000));
const GRAFANA_EVALUATION_TIMEOUT_MS = Math.max(12_000, Number(process.env.GRAFANA_EVALUATION_TIMEOUT_MS || 30_000));
const NAGIOS_EVALUATION_TIMEOUT_MS = Math.max(12_000, Number(process.env.NAGIOS_EVALUATION_TIMEOUT_MS || 30_000));
const MAX_EVALUATION_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_TECHNICAL_EVIDENCE_ITEMS = 50;
const MAX_FEATURE_METRIC_POINTS = 60;
const MAX_EVIDENCE_REFERENCES_PER_SOURCE = 25;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const LIVE_EVALUATION_POLL_INTERVAL_MS = Math.max(30_000, Number(process.env.LIVE_EVALUATION_POLL_INTERVAL_MS || 30_000));
const LIVE_EVALUATION_BATCH_SIZE = Math.min(100, Math.max(1, Number(process.env.LIVE_EVALUATION_BATCH_SIZE || 10)));
const OCCURRENCE_EVIDENCE_REVISION_SQL = `GREATEST(
  appd_occurrence.observed_at, appd_occurrence.updated_at, appd_occurrence.recovery_at,
  grafana_occurrence.observed_at, grafana_occurrence.updated_at, grafana_occurrence.recovery_at,
  nagios_occurrence.observed_at, nagios_occurrence.updated_at, nagios_occurrence.recovery_at
)`;
const OCCURRENCE_EVIDENCE_JOINS_SQL = `
  LEFT JOIN appdynamics_alert_occurrence_evidence appd_occurrence ON appd_occurrence.alert_id = alert.id
  LEFT JOIN grafana_alert_occurrence_evidence grafana_occurrence ON grafana_occurrence.alert_id = alert.id
  LEFT JOIN nagios_alert_occurrence_evidence nagios_occurrence ON nagios_occurrence.alert_id = alert.id
`;
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|api.?key)/i;
const FEEDBACK_RESULT_SQL = `CASE
  WHEN evaluation.final_decision = 'NOISE' AND outcome.outcome = 'CONFIRMED_NOISE' THEN 'CORRECT_NOISE'
  WHEN evaluation.final_decision = 'NOISE' AND outcome.outcome = 'CONFIRMED_INCIDENT' THEN 'FALSE_NOISE'
  WHEN evaluation.final_decision = 'NOISE' AND outcome.outcome = 'UNKNOWN' THEN 'NOISE_TO_UNKNOWN'
  WHEN evaluation.final_decision = 'INCIDENT' AND outcome.outcome = 'CONFIRMED_INCIDENT' THEN 'CORRECT_INCIDENT'
  WHEN evaluation.final_decision = 'INCIDENT' AND outcome.outcome = 'CONFIRMED_NOISE' THEN 'FALSE_INCIDENT'
  WHEN evaluation.final_decision = 'INCIDENT' AND outcome.outcome = 'UNKNOWN' THEN 'INCIDENT_TO_UNKNOWN'
  WHEN evaluation.final_decision = 'NEEDS_REVIEW' AND outcome.outcome = 'CONFIRMED_NOISE' THEN 'REVIEW_TO_NOISE'
  WHEN evaluation.final_decision = 'NEEDS_REVIEW' AND outcome.outcome = 'CONFIRMED_INCIDENT' THEN 'REVIEW_TO_INCIDENT'
  WHEN evaluation.final_decision = 'NEEDS_REVIEW' AND outcome.outcome = 'UNKNOWN' THEN 'REVIEW_REMAINS_UNKNOWN'
  ELSE NULL END`;

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function toIso(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(cleanText).filter(Boolean))];
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function safeJson(value, depth = 0) {
  if (depth > 6 || value === undefined) return null;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 250).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 250).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeJson(item, depth + 1),
    ]));
  }
  return cleanText(value);
}

function safeError(error) {
  return cleanText(error?.safeMessage || error?.code || error?.message || 'Source request failed.')
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|credential|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function validationError(message, code, status = 400) {
  const result = new Error(message);
  result.code = code;
  result.status = status;
  result.safeMessage = message;
  return result;
}

function canonicalSource(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (['appdynamics', 'appd'].includes(normalized)) return 'AppDynamics';
  if (normalized === 'grafana') return 'Grafana';
  if (['nagios', 'nagiosxi', 'nagiosxiv2'].includes(normalized)) return 'Nagios';
  if (normalized === 'thousandeyes') return 'ThousandEyes';
  return null;
}

function structuredSourceFamily(value) {
  const direct = canonicalSource(value);
  if (direct) return direct;
  const prefix = cleanText(value).split('|')[0].trim();
  const prefixed = canonicalSource(prefix);
  if (prefixed) return prefixed;
  if (/^grafana(?:\s|\(|$)/i.test(prefix)) return 'Grafana';
  if (/^appd(?:ynamics)?(?:\s|\(|$)/i.test(prefix)) return 'AppDynamics';
  if (/^nagios(?:\s|\(|$)/i.test(prefix)) return 'Nagios';
  if (/^thousand\s*eyes(?:\s|\(|$)/i.test(prefix)) return 'ThousandEyes';
  return null;
}

function monitoringSourceFromRecord(record, stored = {}) {
  const structuredCandidates = [
    stored.raw_payload?.integrationName,
    stored.raw_payload?.integrationType,
    stored.raw_payload?.source,
    stored.extracted_details?.normalized_alert?.source,
    stored.extracted_details?.jsm_ops?.integrationName,
    record.alert?.source,
  ];
  for (const candidate of structuredCandidates) {
    const source = structuredSourceFamily(candidate);
    if (source) return source;
  }
  return null;
}

function classifyFailure(error) {
  const message = safeError(error);
  const status = Number(error?.vendorStatus || error?.responseStatus || error?.status || 0) || null;
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408 || status === 504 || /timeout|timed out|abort/i.test(message)) return 'TIMEOUT';
  if (/certificate|self signed|unable to verify|tls/i.test(message)) return 'CERTIFICATE_ERROR';
  if (/missing|required|not configured|configuration/i.test(message)) return 'NOT_CONFIGURED';
  return 'UNAVAILABLE';
}

function recursiveField(value, names, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, item] of Object.entries(value)) {
    if (wanted.has(key.toLowerCase()) && item !== null && item !== undefined && item !== '') return item;
  }
  for (const item of Object.values(value)) {
    const found = recursiveField(item, names, depth + 1);
    if (found !== null && found !== undefined && found !== '') return found;
  }
  return null;
}

function sourceMetadata(record, stored = {}) {
  const payload = stored.raw_payload || {};
  const extracted = stored.extracted_details || {};
  const deepLinks = extractDeepLinkIdentity([stored.source_url, payload, extracted]);
  const from = (names) => recursiveField(extracted, names) ?? recursiveField(payload, names);
  const tags = [...(Array.isArray(payload.tags) ? payload.tags : []),
    ...(Array.isArray(extracted?.normalized_alert?.tags) ? extracted.normalized_alert.tags : [])];
  const tagged = (names) => {
    const wanted = names.map((name) => String(name).toLowerCase());
    const match = tags.find((tag) => {
      const prefix = cleanText(tag).split(':')[0].toLowerCase();
      return wanted.includes(prefix);
    });
    return match ? cleanText(match).slice(cleanText(match).indexOf(':') + 1).trim() : null;
  };
  const tagLabels = tags.reduce((labels, tag) => {
    const value = cleanText(tag);
    const separator = value.indexOf(':');
    if (separator <= 0) return labels;
    const key = value.slice(0, separator).trim();
    const labelValue = value.slice(separator + 1).trim();
    if (key && labelValue && labels[key] === undefined) labels[key] = labelValue;
    return labels;
  }, {});
  const meaningful = (value) => /^(unknown|unknown[-_ ]service|not[-_ ]available|n\/a)$/i.test(cleanText(value))
    ? null : value;
  const originalSource = cleanText(payload.source || payload.integrationName || record.alert?.source);
  const originalCanonical = canonicalSource(originalSource.split('|')[0]) || canonicalSource(payload.integrationName);
  const sourceSuffix = originalSource.includes('|') ? cleanText(originalSource.split('|').slice(1).join('|')) : null;
  const alias = cleanText(payload.alias || extracted?.jsm_ops?.alias || extracted?.normalized_alert?.alias);
  const appTitleName = cleanText(stored.title || record.alert?.message).match(/^\[AppD(?:ynamics)?\]\s+([^ ]+)/i)?.[1] || null;
  const nagiosAlias = originalCanonical === 'Nagios' && alias
    ? { host: alias.split('_')[0], service: alias.includes('_') ? alias.split('_').slice(1).join('_') : null } : {};
  const sourceStrings = [];
  const collectStrings = (value, depth = 0) => {
    if (value === null || value === undefined || depth > 7 || sourceStrings.length >= 300) return;
    if (typeof value === 'string') { sourceStrings.push(value); return; }
    if (Array.isArray(value)) { value.forEach((item) => collectStrings(item, depth + 1)); return; }
    if (typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, depth + 1));
  };
  collectStrings([stored.source_url, payload, extracted]);
  const sourceUrls = unique(sourceStrings.flatMap((value) => value.match(/https?:\/\/[^\s<>"']+/gi) || [])
    .map((value) => value.replace(/&amp;/gi, '&').replace(/[),.;]+$/, '')));
  const grafanaDeepLink = sourceUrls.find((value) => /grafana/i.test(value) && /\/alerting\/grafana\/[^/?#]+/i.test(value))
    || sourceUrls.find((value) => /grafana/i.test(value) && /\/d\/[^/?#]+/i.test(value))
    || sourceUrls.find((value) => /grafana/i.test(value) && /\/alerting\//i.test(value)) || null;
  const grafanaSourceUrl = grafanaDeepLink || sourceUrls.find((value) => /grafana/i.test(value)) || null;
  const grafanaIntegrationHost = cleanText(payload.integrationName || payload.integrationType)
    .match(/grafana[^()]*(?:\(|\bat\s+)([a-z0-9.-]+\.[a-z]{2,})(?:\)|\b)/i)?.[1]?.toLowerCase() || null;
  const appDynamicsDeepLink = sourceUrls.find((value) => /appdynamics/i.test(value) && /(?:eventSummary|incident)=/i.test(value))
    || sourceUrls.find((value) => /appdynamics/i.test(value) && /application=/i.test(value)) || null;
  return {
    originalSource,
    sourceAlias: alias || null,
    sourceIntegration: cleanText(payload.integrationName || payload.integrationType) || null,
    applicationId: deepLinks.appDynamicsApplicationIds[0] || from(['applicationId', 'application_id'])
      || record.sourceIdentity?.applicationId,
    appDynamicsApplicationName: from(['applicationName', 'application_name'])
      || (originalCanonical === 'AppDynamics' ? sourceSuffix : null)
      || appTitleName,
    appDynamicsSourceAlertId: deepLinks.appDynamicsEventIds[0] || from(['eventId', 'event_id'])
      || (originalCanonical === 'AppDynamics' ? alias : null),
    appDynamicsViolationId: from(['violationId', 'violation_id'])
      || (originalCanonical === 'AppDynamics' ? alias : null),
    appDynamicsDeepLink,
    appDynamicsTier: from(['tierName', 'tier']),
    appDynamicsNode: from(['nodeName', 'node']),
    appDynamicsBusinessTransaction: from(['businessTransactionName', 'businessTransaction', 'business_transaction']),
    appDynamicsHealthRule: from(['healthRuleName', 'healthRule', 'health_rule']),
    appDynamicsMetric: from(['metricName', 'metric', 'metric_path']),
    grafanaRuleUid: from(['ruleUid', 'rule_uid', 'alertRuleUid']) || deepLinks.grafanaRuleUids[0],
    grafanaDashboardUid: from(['dashboardUid', 'dashboard_uid']) || deepLinks.grafanaDashboardUids[0],
    grafanaPanelId: from(['panelId', 'panel_id']) || deepLinks.grafanaPanelIds[0],
    grafanaFolder: from(['folderTitle', 'folder']) || tagged(['grafana_folder', 'folder']),
    grafanaAlertName: from(['alertName', 'alertname', 'ruleName']) || tagged(['alertname', 'rule_name']),
    grafanaEnvironment: meaningful(record.sourceIdentity?.environment)
      || meaningful(from(['environment', 'env'])) || meaningful(tagged(['environment', 'env', 'label_env'])),
    grafanaInstance: meaningful(from(['instance'])) || meaningful(tagged(['instance'])),
    grafanaService: meaningful(record.sourceIdentity?.service) || meaningful(from(['service']))
      || meaningful(tagged(['service', 'label_service'])),
    grafanaTeam: meaningful(from(['team', 'team_name'])) || meaningful(tagged(['team', 'label_team'])),
    grafanaLabels: { ...tagLabels, ...safeJson(from(['labels']) || {}) },
    grafanaAnnotations: safeJson(from(['annotations']) || {}),
    grafanaDeepLink,
    grafanaSourceUrl,
    grafanaIntegrationHost,
    grafanaSourceHost: (() => {
      try { return new URL(grafanaSourceUrl).hostname.toLowerCase(); } catch { return grafanaIntegrationHost; }
    })(),
    grafanaDetailReadFailure: stored.grafana_detail_read_failure || null,
    nagiosHost: meaningful(from(['hostName', 'host', 'hostname'])) || deepLinks.nagiosHosts[0] || nagiosAlias.host || null,
    nagiosService: meaningful(from(['serviceDescription', 'service_name', 'service'])) || deepLinks.nagiosServices[0] || nagiosAlias.service || null,
    nagiosEnvironment: from(['instanceKey', 'sourceInstance', 'nagiosEnvironment']) || deepLinks.nagiosSites[0] || payload.integrationName || null,
    thousandEyesTestId: from(['testId', 'test_id']) || deepLinks.thousandEyesTestIds[0],
    thousandEyesAlertId: from(['alertId', 'alert_id', 'eventId']) || deepLinks.thousandEyesAlertIds[0],
  };
}

function buildAlertContext(record, stored = {}) {
  const metadata = sourceMetadata(record, stored);
  const monitoringSource = monitoringSourceFromRecord(record, stored);
  return normalizeOperationsAlert({
    id: stored.atlassian_ops_alert_id || record.alert.canonicalAlertId || record.alert.alertId,
    tinyId: stored.atlassian_ops_tiny_id || null,
    sourceSystem: monitoringSource || record.alert.source,
    title: stored.title || record.alert.message,
    message: record.alert.message,
    service: record.sourceIdentity?.service,
    application: record.sourceIdentity?.application,
    environment: record.sourceIdentity?.environment,
    priority: record.alert.priority,
    severity: record.alert.severity,
    createdAt: record.temporalFeatures?.createdAt || record.featureAsOf,
    updatedAt: record.temporalFeatures?.lastSeen,
    lastOccurredAt: record.temporalFeatures?.lastSeen,
    sourceDetails: metadata,
    sourceIdentifiers: {
      applicationId: metadata.applicationId,
      eventId: metadata.appDynamicsSourceAlertId,
      ruleUid: metadata.grafanaRuleUid,
      dashboardUid: metadata.grafanaDashboardUid,
      panelId: metadata.grafanaPanelId,
      host: metadata.nagiosHost,
      service: metadata.nagiosService,
      testId: metadata.thousandEyesTestId,
      alertId: metadata.thousandEyesAlertId,
    },
    sourceUrl: stored.source_url || record.alert.sourceUrl || null,
    tags: stored.raw_payload?.tags || [],
  }, record.sourceIdentity || null);
}

function directSourceMapping(source, alert) {
  const metadata = alert.sourceMetadata || {};
  if (source === 'AppDynamics' && metadata.applicationId) return {
    source, level: 'EXACT', confidence: 100, sourceEntityId: String(metadata.applicationId),
    sourceEntityName: metadata.appDynamicsApplicationName || alert.application || alert.canonicalEntity,
    sourceEntityType: 'APPLICATION',
    metadata: {
      applicationId: String(metadata.applicationId),
      sourceAlertId: metadata.appDynamicsSourceAlertId || null,
      eventId: metadata.appDynamicsSourceAlertId || null,
      violationId: metadata.appDynamicsViolationId || null,
      deepLink: metadata.appDynamicsDeepLink || null,
    },
    reasons: [metadata.appDynamicsSourceAlertId
      ? 'Exact AppDynamics event deep link and application identifier'
      : 'Exact stored AppDynamics application identifier'],
  };
  if (source === 'Grafana' && (metadata.grafanaRuleUid || (metadata.grafanaDashboardUid && metadata.grafanaPanelId))) return {
    source, level: 'EXACT', confidence: 100,
    sourceEntityId: String(metadata.grafanaRuleUid || `${metadata.grafanaDashboardUid}:${metadata.grafanaPanelId}`),
    sourceEntityName: metadata.grafanaAlertName || alert.alertName, sourceEntityType: metadata.grafanaRuleUid ? 'ALERT_RULE' : 'PANEL',
    metadata: {
      ruleUid: metadata.grafanaRuleUid, dashboardUid: metadata.grafanaDashboardUid,
      panelId: metadata.grafanaPanelId, folder: metadata.grafanaFolder,
      sourceUrl: metadata.grafanaSourceUrl, deepLink: metadata.grafanaDeepLink,
      sourceHost: metadata.grafanaSourceHost, integrationHost: metadata.grafanaIntegrationHost,
      alertName: metadata.grafanaAlertName,
      labels: metadata.grafanaLabels, annotations: metadata.grafanaAnnotations,
    },
    reasons: ['Exact stored Grafana rule or dashboard/panel identifier'],
  };
  const grafanaComposite = [metadata.grafanaEnvironment, metadata.grafanaInstance,
    metadata.grafanaFolder, metadata.grafanaService, metadata.grafanaTeam, metadata.grafanaSourceHost].filter(Boolean);
  if (source === 'Grafana' && metadata.grafanaAlertName && grafanaComposite.length >= 1) return {
    source, level: 'CANDIDATE', confidence: 60, usableForSourceValidation: false,
    sourceEntityId: String(metadata.grafanaAlertName),
    sourceEntityName: metadata.grafanaAlertName,
    sourceEntityType: 'ALERT_RULE_COMPOSITE',
    metadata: {
      alertName: metadata.grafanaAlertName, environment: metadata.grafanaEnvironment,
      instance: metadata.grafanaInstance, folder: metadata.grafanaFolder,
      service: metadata.grafanaService, team: metadata.grafanaTeam,
      sourceUrl: metadata.grafanaSourceUrl, deepLink: metadata.grafanaDeepLink,
      sourceHost: metadata.grafanaSourceHost, integrationHost: metadata.grafanaIntegrationHost,
      requiresInventoryUniqueness: true,
    },
    reasons: ['Structured Grafana alert name plus source context is a candidate; source inventory must establish uniqueness'],
  };
  if (source === 'Nagios' && (metadata.nagiosHost || metadata.nagiosService)) return {
    source, level: 'EXACT', confidence: 100,
    sourceEntityId: String([metadata.nagiosHost, metadata.nagiosService].filter(Boolean).join('::')),
    sourceEntityName: metadata.nagiosService || metadata.nagiosHost,
    sourceEntityType: metadata.nagiosService ? 'SERVICE' : 'HOST',
    metadata: { host: metadata.nagiosHost, service: metadata.nagiosService, instance: metadata.nagiosEnvironment },
    reasons: ['Exact stored Nagios host/service identifier'],
  };
  if (source === 'ThousandEyes' && (metadata.thousandEyesAlertId || metadata.thousandEyesTestId)) return {
    source, level: 'EXACT', confidence: 100,
    sourceEntityId: String(metadata.thousandEyesAlertId || metadata.thousandEyesTestId),
    sourceEntityName: alert.canonicalEntity || alert.alertName,
    sourceEntityType: metadata.thousandEyesAlertId ? 'ALERT' : 'TEST',
    metadata: { alertId: metadata.thousandEyesAlertId, testId: metadata.thousandEyesTestId },
    reasons: ['Exact stored ThousandEyes alert/test identifier'],
  };
  return null;
}

function observedNoiseDetection(record) {
  const labels = {
    duplicate: 'DUPLICATE', flapping: 'FLAPPING', autoResolved: 'AUTO_RESOLVED',
    nonActionable: 'NON_ACTIONABLE', correlated: 'CORRELATED', stale: 'STALE',
    expectedActivity: 'EXPECTED_ACTIVITY',
  };
  const observed = Object.entries(labels).filter(([key]) => record.observedBehavior?.[key]?.state === 'OBSERVED');
  const available = Object.values(record.observedBehavior || {}).filter((item) => item?.state && item.state !== 'UNAVAILABLE');
  return {
    primary: observed[0]?.[1] || (available.length ? 'NO_STRONG_NOISE_PATTERN' : 'UNKNOWN'),
    observed: observed.map(([, label]) => label),
    evidence: observed.map(([key, label]) => ({
      type: label,
      detail: record.observedBehavior[key]?.detail || null,
      evidenceIds: record.observedBehavior[key]?.evidenceIds || [],
    })),
    createsDecision: false,
  };
}

function buildFeatureSnapshot(record, technicalEvidence, featureAsOf) {
  return {
    schemaVersion: 'live-multi-source-t0-v1',
    featureAsOf,
    identity: {
      source: canonicalSource(record.alert.source),
      application: record.sourceIdentity.application || null,
      service: record.sourceIdentity.service || null,
      entity: record.sourceIdentity.entity || null,
      environment: record.sourceIdentity.environment || null,
    },
    technicalClassification: {
      domain: record.alertClassification?.domain || 'UNKNOWN_DOMAIN',
      subtype: record.alertClassification?.subtype || 'UNKNOWN_SUBTYPE',
      assignmentMethod: record.alertClassification?.assignmentMethod || null,
    },
    operationalPriority: {
      value: record.alert?.priority || null,
      signal: prioritySignal(record.alert?.priority),
      mandatoryOutcome: null,
    },
    currentBehavior: {
      durationSeconds: record.temporalFeatures?.durationSeconds ?? null,
      occurrences: record.behaviorFeatures?.occurrenceCount ?? null,
      recurrenceCount: record.behaviorFeatures?.recurrenceCount ?? null,
      persistenceSeconds: record.behaviorFeatures?.persistenceSeconds ?? null,
      stateTransitionCount: record.behaviorFeatures?.stateTransitionCount ?? null,
      correlatedAlertCount: record.correlationFeatures?.relatedAlertCount ?? null,
      crossSourceActivity: record.correlationFeatures?.crossSourceActivity ?? null,
      observedNoiseFeatures: observedNoiseDetection(record).observed,
      notificationRelationship: record.notificationRelationship || null,
    },
    sourceSpecificMetrics: technicalEvidence.metrics,
    historicalContext: {
      previousSameSignature: record.historicalFeatures?.previousSameSignatureCount ?? null,
      previousSameService: record.historicalFeatures?.previousSameServiceCount ?? null,
      previousSameEntity: record.historicalFeatures?.previousSameEntityCount ?? null,
      previousIncidentOccurrences: record.historicalFeatures?.previousConfirmedIncidentCount ?? null,
      previousConfirmedNoiseOutcomes: record.historicalFeatures?.previousConfirmedNoiseCount ?? null,
      asOf: record.historicalFeatures?.asOf || record.featureAsOf,
      futureRecordsExcluded: true,
    },
    leakageBoundary: {
      jiraIncidentCreatedAtExcluded: true,
      jiraIncidentKeyExcluded: true,
      finalResolutionExcluded: true,
      operatorOutcomeExcluded: true,
      modelPredictionExcludedFromLabel: true,
    },
  };
}

function technicalEvidenceContract(source, alert, blocks) {
  const monitoring = blocks.filter((block) => SUPPORTED_SOURCES.includes(block.source));
  const records = monitoring.flatMap((block) => block.evidence || []);
  const metrics = records.filter((item) => /metric|telemetry/i.test(item.type || '') || item.metadata?.metric)
    .slice(-MAX_FEATURE_METRIC_POINTS)
    .map((item) => ({
      source: item.source,
      metric: item.metadata?.metric || item.metadata?.metricName || item.title || null,
      value: item.metadata?.value ?? null,
      unit: item.metadata?.unit || null,
      timestamp: item.timestamp || null,
      evidenceId: item.id,
    }));
  const primary = monitoring.find((block) => block.source === source) || null;
  const evidenceSources = unique(records.map((item) => item.source));
  return {
    source,
    sourceAlertId: alert.sourceMetadata?.thousandEyesAlertId || alert.sourceMetadata?.grafanaRuleUid
      || alert.sourceMetadata?.appDynamicsSourceAlertId || alert.sourceMetadata?.applicationId
      || alert.sourceMetadata?.nagiosHost || alert.operationsAlertId || null,
    timestamp: alert.createdAt || null,
    identity: alert.canonicalEntity || null,
    application: alert.application || null,
    service: alert.service || null,
    environment: alert.environment || null,
    severity: alert.severity || null,
    currentState: records.find((item) => item.metadata?.state || item.metadata?.status)?.metadata?.state
      || records.find((item) => item.metadata?.status)?.metadata?.status || null,
    metrics,
    thresholds: records.filter((item) => item.metadata?.threshold !== undefined).map((item) => ({
      threshold: item.metadata.threshold, metric: item.metadata.metric || item.title, evidenceId: item.id,
    })),
    persistence: null,
    recurrence: null,
    relatedEntities: unique(records.flatMap((item) => [item.entity, ...(item.metadata?.agentIds || [])]))
      .slice(0, MAX_TECHNICAL_EVIDENCE_ITEMS),
    sourceSpecificEvidence: safeJson(records.slice(-MAX_TECHNICAL_EVIDENCE_ITEMS)),
    deepLink: records.find((item) => item.url)?.url || null,
    provenance: {
      adapters: monitoring.map((block) => block.adapter),
      evidenceIds: records.map((item) => item.id),
      evidenceSources,
      primaryStatus: primary?.status || 'not_applicable',
      primaryFailureReason: primary?.failureReason || null,
      readOnly: true,
    },
  };
}

function safeDiagnosticQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return safeJson(query || null);
  const { rawRecords, normalizedRecords, records, ...summary } = query;
  return safeJson({
    ...summary,
    rawRecordCount: query.rawRecordCount ?? rawRecords?.length ?? null,
    normalizedRecordCount: query.normalizedRecordCount ?? normalizedRecords?.length ?? records?.length ?? null,
    recordSamples: safeJson((normalizedRecords || rawRecords || records || []).slice(0, 3)),
  });
}

function operationalDimensions(record, blocks) {
  const jira = blocks.find((block) => block.source === 'ACC Jira');
  const confirmedJira = (jira?.relationships || []).some((item) => item.relationship === 'confirmed');
  const monitoringRecords = blocks.filter((block) => SUPPORTED_SOURCES.includes(block.source)).flatMap((block) => block.evidence || []);
  const activeSourceEvidence = monitoringRecords.some((item) => /active|trigger|firing|critical|down|violation/i.test(cleanText([
    item.metadata?.state, item.metadata?.status, item.severity, item.summary,
  ].join(' '))));
  const duplicate = record.observedBehavior?.duplicate?.state === 'OBSERVED';
  return {
    businessImpact: 'UNKNOWN',
    actionability: 'UNKNOWN',
    underlyingEvent: confirmedJira ? 'CONFIRMED_INCIDENT' : activeSourceEvidence ? 'TECHNICAL_EVENT' : 'UNKNOWN',
    notificationRole: duplicate ? 'REDUNDANT' : 'UNKNOWN',
    provenance: {
      confirmedJiraRelationship: confirmedJira,
      activeSourceEvidence,
      duplicateObserved: duplicate,
    },
  };
}

function buildShadowDecision({ source, technicalEvidence, experimentPrediction }) {
  const missingTechnicalEvidence = technicalEvidence.provenance.primaryStatus !== 'working';
  const reasons = [
    missingTechnicalEvidence
      ? 'Source monitoring API unavailable; fallback operational evidence used.'
      : 'The available evidence does not distinguish an Incident from Noise unambiguously.',
    'The evaluation remains in shadow mode and cannot trigger an operational action.',
  ];
  return {
    finalDecision: 'NEEDS_REVIEW',
    confidence: null,
    modelVersion: MODEL_VERSION,
    modelReleaseStatus: RELEASE_STATUS,
    experimentalIncidentRiskScore: experimentPrediction?.incidentRiskScore ?? null,
    experimentalModelVersion: experimentPrediction?.modelVersion || null,
    experimentalScoreApproved: false,
    reasons,
    evidenceGaps: missingTechnicalEvidence ? ['SOURCE_API_UNAVAILABLE'] : [],
    fallbackReason: 'INSUFFICIENT_OR_CONFLICTING_EVIDENCE',
  };
}

function feedbackErrorType(prediction, actualOutcome) {
  if (prediction === 'NOISE' && actualOutcome === 'CONFIRMED_NOISE') return 'CORRECT_NOISE';
  if (prediction === 'NOISE' && actualOutcome === 'CONFIRMED_INCIDENT') return 'FALSE_NOISE';
  if (prediction === 'INCIDENT' && actualOutcome === 'CONFIRMED_INCIDENT') return 'CORRECT_INCIDENT';
  if (prediction === 'INCIDENT' && actualOutcome === 'CONFIRMED_NOISE') return 'FALSE_INCIDENT';
  if (prediction === 'NEEDS_REVIEW' && actualOutcome === 'UNKNOWN') return 'REVIEW_REMAINS_UNKNOWN';
  if (prediction === 'NEEDS_REVIEW' && actualOutcome === 'CONFIRMED_NOISE') return 'REVIEW_TO_NOISE';
  if (prediction === 'NEEDS_REVIEW' && actualOutcome === 'CONFIRMED_INCIDENT') return 'REVIEW_TO_INCIDENT';
  if (prediction === 'INCIDENT' && actualOutcome === 'UNKNOWN') return 'INCIDENT_TO_UNKNOWN';
  if (prediction === 'NOISE' && actualOutcome === 'UNKNOWN') return 'NOISE_TO_UNKNOWN';
  return null;
}

function goldTrainingEligibility(outcome) {
  if (outcome === 'CONFIRMED_NOISE') {
    return { status: 'TRAINING_ELIGIBLE', label: 'NOISE' };
  }
  if (outcome === 'CONFIRMED_INCIDENT') {
    return { status: 'TRAINING_ELIGIBLE', label: 'INCIDENT' };
  }
  if (outcome === 'UNKNOWN' || outcome === 'NEEDS_REVIEW') {
    return { status: 'TRAINING_ELIGIBLE', label: 'NEEDS_REVIEW' };
  }
  return { status: 'NOT_TRAINING_ELIGIBLE', label: null };
}

function isCorrectFeedbackResult(value) {
  return ['CORRECT_NOISE', 'CORRECT_INCIDENT'].includes(value);
}

function ratio(numerator, denominator) {
  return denominator ? Number((Number(numerator) / Number(denominator)).toFixed(6)) : null;
}

function f1(precision, recall) {
  return precision !== null && recall !== null && precision + recall
    ? Number(((2 * precision * recall) / (precision + recall)).toFixed(6)) : null;
}

function calculateEvaluationMetrics(rows = [], minimum = MINIMUM_PERFORMANCE_LABELS) {
  const confirmed = rows.filter((row) => ['CONFIRMED_NOISE', 'CONFIRMED_INCIDENT'].includes(row.actual_outcome));
  const actualNoise = confirmed.filter((row) => row.actual_outcome === 'CONFIRMED_NOISE').length;
  const actualIncident = confirmed.filter((row) => row.actual_outcome === 'CONFIRMED_INCIDENT').length;
  const sufficient = confirmed.length >= minimum && actualNoise > 0 && actualIncident > 0;
  if (!sufficient) return {
    sampleSize: confirmed.length,
    actualNoise,
    actualIncident,
    status: 'INSUFFICIENT_SAMPLE',
    metrics: null,
  };
  const incidentTp = confirmed.filter((row) => row.prediction === 'INCIDENT' && row.actual_outcome === 'CONFIRMED_INCIDENT').length;
  const incidentFp = confirmed.filter((row) => row.prediction === 'INCIDENT' && row.actual_outcome !== 'CONFIRMED_INCIDENT').length;
  const incidentFn = confirmed.filter((row) => row.prediction !== 'INCIDENT' && row.actual_outcome === 'CONFIRMED_INCIDENT').length;
  const noiseTp = confirmed.filter((row) => row.prediction === 'NOISE' && row.actual_outcome === 'CONFIRMED_NOISE').length;
  const noiseFp = confirmed.filter((row) => row.prediction === 'NOISE' && row.actual_outcome !== 'CONFIRMED_NOISE').length;
  const noiseFn = confirmed.filter((row) => row.prediction !== 'NOISE' && row.actual_outcome === 'CONFIRMED_NOISE').length;
  const incidentPrecision = ratio(incidentTp, incidentTp + incidentFp);
  const incidentRecall = ratio(incidentTp, incidentTp + incidentFn);
  const noisePrecision = ratio(noiseTp, noiseTp + noiseFp);
  const noiseRecall = ratio(noiseTp, noiseTp + noiseFn);
  return {
    sampleSize: confirmed.length,
    actualNoise,
    actualIncident,
    status: 'AVAILABLE',
    metrics: {
      incidentPrecision,
      incidentRecall,
      incidentF1: f1(incidentPrecision, incidentRecall),
      incidentFalseNegativeRate: ratio(incidentFn, actualIncident),
      noisePrecision,
      noiseRecall,
      noiseF1: f1(noisePrecision, noiseRecall),
      falseNoiseRate: ratio(noiseFp, noiseTp + noiseFp),
      noiseFalsePositiveRate: ratio(noiseFp, actualIncident),
      reviewRate: ratio(confirmed.filter((row) => row.prediction === 'NEEDS_REVIEW').length, confirmed.length),
      prAuc: null,
      calibration: null,
      probabilityMetricsStatus: 'NOT_AVAILABLE_WITH_UNCALIBRATED_EVIDENCE_SCORE',
      confusionMatrix: {
        actualNoise: {
          noise: noiseTp,
          incident: confirmed.filter((row) => row.prediction === 'INCIDENT' && row.actual_outcome === 'CONFIRMED_NOISE').length,
          needsReview: confirmed.filter((row) => row.prediction === 'NEEDS_REVIEW' && row.actual_outcome === 'CONFIRMED_NOISE').length,
        },
        actualIncident: {
          noise: noiseFp,
          incident: incidentTp,
          needsReview: confirmed.filter((row) => row.prediction === 'NEEDS_REVIEW' && row.actual_outcome === 'CONFIRMED_INCIDENT').length,
        },
      },
    },
  };
}

function mapEvaluation(row) {
  if (!row) return null;
  const episode = row.feature_snapshot?.episode || null;
  const lifecycle = row.technical_evidence?.monitoringLifecycle || null;
  return {
    evaluationId: row.evaluation_id,
    decisionRevision: row.evaluation_id,
    evidenceRevision: toIso(row.feature_as_of),
    requestId: row.request_id,
    alertId: row.alert_id,
    source: row.source,
    sourceAlertId: row.source_alert_id,
    featureAsOf: toIso(row.feature_as_of),
    mode: row.mode,
    model: {
      version: row.model_version,
      releaseStatus: row.model_release_status,
      confidence: row.confidence === null ? null : Number(row.confidence),
      experimentalIncidentRiskScore: row.experimental_incident_risk_score === null ? null : Number(row.experimental_incident_risk_score),
      confidenceCalibrated: false,
    },
    decisionPolicy: row.decision_policy || DECISION_POLICY_VERSION,
    decisionConfidence: row.decision_confidence || DECISION_CONFIDENCE,
    evidenceScore: row.evidence_score === null || row.evidence_score === undefined ? null : Number(row.evidence_score),
    evidenceVector: row.evidence_vector || {},
    evaluationStatus: row.evaluation_status || EVALUATION_STATUS,
    feedbackStatus: row.feedback_status || 'UNLABELED',
    noiseDetection: row.noise_detection || {},
    classification: row.classification || {},
    businessImpact: row.business_impact,
    actionability: row.actionability,
    underlyingEvent: row.underlying_event,
    notificationRole: row.notification_role,
    finalDecision: row.final_decision,
    featureSnapshot: row.feature_snapshot || {},
    episodeId: episode?.episodeId || null,
    groupingBasis: episode?.episodeGroupingBasis || null,
    groupingEvidence: episode?.groupingEvidenceIds || episode?.groupingEvidence || [],
    currentLifecycle: lifecycle ? {
      currentlyFiring: lifecycle.persistence?.currentlyFiring ?? null,
      recovered: lifecycle.recovery?.recovered ?? null,
      recoveredAt: lifecycle.recovery?.recoveredAt || null,
      flapping: lifecycle.persistence?.flapping ?? null,
    } : null,
    evidenceStatus: row.technical_evidence?.coverage?.evidenceCompleteness?.status || null,
    prioritySignal: row.feature_snapshot?.operationalPriority?.signal || 'UNKNOWN',
    technicalEvidence: row.technical_evidence || {},
    evidenceReferences: row.evidence_references || [],
    explanation: row.explanation || {},
    adapterDiagnostics: row.adapter_diagnostics || [],
    sourceDetails: row.source_details || {},
    sourceProvenance: row.source_provenance || [],
    observability: row.observability || {},
    failureReasons: row.failure_reasons || [],
    evaluationTimeMs: Number(row.evaluation_time_ms || 0),
    sourceMutations: Number(row.source_mutations || 0),
    createdAt: toIso(row.created_at),
  };
}

function withTimeout(promise, milliseconds, source) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        source,
        adapter: `${source.replace(/\s+/g, '')}EvidenceAdapter`,
        status: 'error', pipelineState: 'QUERY_FAILED', evidence: [], relationships: [],
        failureReason: 'SOURCE_TIMEOUT', readOnly: true, executionTimeMs: milliseconds,
      }), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function createLiveMultiSourceEvaluationService({
  database = db,
  learning = learningDatasetService,
  outcomes = operationalOutcomeService,
  adapters = createSourceEvidenceAdapterRegistry(),
  appDynamics = appDynamicsService,
  grafana = grafanaService,
  nagios = nagiosService,
  thousandEyesRuntime = thousandEyesRuntimeService,
  thousandEyesWorkspace = thousandEyesWorkspaceService,
  episodeLayer = alertEpisodeService,
  patternLearning = null,
  now = () => Date.now(),
} = {}) {
  let schemaReady;
  let pollingTimer = null;
  let pollingInProgress = false;
  const sourceCircuits = new Map();
  let appDynamicsIdentityCache = { expiresAt: 0, applications: [] };

  async function ensureSchema() {
    if (!schemaReady) schemaReady = database.query(migrationSql).catch((error) => {
      schemaReady = null;
      throw error;
    });
    await schemaReady;
  }

  async function storedAlert(alertId) {
    const result = await database.query(`
      SELECT id, title, source, source_url, raw_payload, extracted_details,
        atlassian_ops_alert_id, atlassian_ops_tiny_id
      FROM alerts WHERE id = $1 LIMIT 1
    `, [alertId]);
    return result.rows[0] || null;
  }

  async function notificationRelationship(alertId, source) {
    const result = await database.query(`
      WITH target AS (
        SELECT learning_alert_signature_v1 AS signature, learning_entity_key_v1 AS entity_key
        FROM alerts WHERE id = $1
      )
      SELECT alert.id, alert.received_at, COALESCE(alert.last_seen_at, alert.received_at) AS last_seen_at,
        COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source) AS source_name,
        alert.learning_alert_signature_v1 AS signature
      FROM alerts alert
      CROSS JOIN target
      WHERE target.signature IS NOT NULL
        AND target.entity_key IS NOT NULL
        AND alert.learning_alert_signature_v1 = target.signature
        AND alert.learning_entity_key_v1 = target.entity_key
        AND alert.atlassian_ops_alert_id IS NOT NULL
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
      ORDER BY alert.received_at, alert.id
    `, [alertId]);
    const candidates = result.rows.filter((row) => (
      structuredSourceFamily(row.source_name) === source
    )).map((row) => {
      const start = new Date(row.received_at).getTime();
      const observedEnd = new Date(row.last_seen_at).getTime();
      return { ...row, start, end: Number.isFinite(observedEnd) ? Math.max(start, observedEnd) : start };
    });
    const components = [];
    let component = [];
    let componentEnd = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      if (component.length && candidate.start > componentEnd) {
        components.push(component);
        component = [];
        componentEnd = Number.NEGATIVE_INFINITY;
      }
      component.push(candidate);
      componentEnd = Math.max(componentEnd, candidate.end);
    }
    if (component.length) components.push(component);
    const group = components.find((items) => items.some((item) => item.id === alertId)) || [];
    if (group.length < 2) return null;
    const primary = group[0];
    const groupId = `notification-group-${hash(group.map((item) => item.id).join('|'))}`;
    return {
      primaryAlertId: primary.id,
      duplicateOf: alertId === primary.id ? null : primary.id,
      duplicateGroupId: groupId,
      groupSize: group.length,
      relationshipMethod: 'EXACT_SIGNATURE_ENTITY_SOURCE_OVERLAPPING_WINDOW',
      evidenceIds: group.map((item) => `jsm-notification:${item.id}`),
    };
  }

  async function phase13Evaluation(alertId) {
    const result = await database.query(`
      SELECT evaluation_id, final_decision, noise_detection, classification,
        business_impact, actionability, underlying_event, notification_role,
        explanation, evidence_references, created_at
      FROM live_shadow_evaluations
      WHERE alert_id = $1 AND decision_policy = 'PHASE13_DECISION_QUALITY_SHADOW_V1'
      ORDER BY created_at DESC, feature_as_of DESC
      LIMIT 1
    `, [alertId]);
    return result.rows[0] || null;
  }

  async function enrichMonitoringStoredAlert(record, stored) {
    const monitoringSource = monitoringSourceFromRecord(record, stored);
    if (!['Grafana', 'AppDynamics'].includes(monitoringSource) || !stored?.atlassian_ops_alert_id) return stored;
    try {
      const response = await operationsReadService.getAlert(stored.atlassian_ops_alert_id);
      const raw = response?.alert?.rawOperationsPayload;
      if (!raw || typeof raw !== 'object') return stored;
      return {
        ...stored,
        raw_payload: raw,
        title: response.alert?.message || response.alert?.summary || stored.title,
        grafana_detail_read_failure: monitoringSource === 'Grafana' ? null : stored.grafana_detail_read_failure,
        appdynamics_detail_read_failure: monitoringSource === 'AppDynamics' ? null : stored.appdynamics_detail_read_failure,
      };
    } catch (error) {
      return monitoringSource === 'Grafana'
        ? { ...stored, grafana_detail_read_failure: classifyFailure(error) }
        : { ...stored, appdynamics_detail_read_failure: classifyFailure(error) };
    }
  }

  async function validatedMappings(record, alert) {
    const mappings = [];
    const entityId = record.sourceIdentity?.entityId;
    if (entityId) {
      const result = await database.query(`
        SELECT entity_id, source_system, source_entity_id, source_entity_name,
          source_entity_type, confidence_score, mapping_mechanism, identity_fields,
          reasons, provenance
        FROM source_identity_validated_mappings
        WHERE entity_id = $1 AND validation_status = 'VALID'
      `, [entityId]);
      result.rows.forEach((row) => mappings.push({
        source: row.source_system,
        level: 'CONFIRMED_LOCAL',
        confidence: Number(row.confidence_score || 100),
        sourceEntityId: row.source_entity_id,
        sourceEntityName: row.source_entity_name,
        sourceEntityType: row.source_entity_type,
        metadata: safeJson(row.identity_fields || {}),
        reasons: unique([
          `Validated local mapping: ${row.mapping_mechanism || 'stored decision'}`,
          ...(Array.isArray(row.reasons) ? row.reasons : []),
        ]),
        provenance: safeJson(row.provenance || []),
      }));
    }
    const source = canonicalSource(alert.source);
    const direct = source ? directSourceMapping(source, alert) : null;
    if (direct && source === 'Nagios') {
      const existingNagios = mappings.find((item) => canonicalSource(item.source) === 'Nagios');
      const instanceHint = cleanText(existingNagios?.metadata?.instance)
        || cleanText(existingNagios?.sourceEntityId).match(/^(d0[12])(?=:)/i)?.[1]
        || null;
      if (!direct.metadata.instance && instanceHint) direct.metadata.instance = instanceHint.toLowerCase();
      // The current JSM Operations alias is the occurrence-specific Nagios
      // identity. Preserve older validated mappings for audit, but query this
      // exact alias first so a stale service mapping cannot override it.
      mappings.unshift(direct);
    } else if (direct && source === 'AppDynamics') {
      // An exact AppDynamics application/event deep link from the current
      // Operations payload is occurrence-specific and takes precedence over
      // older application-only identity mappings.
      mappings.unshift(direct);
    } else if (direct && !mappings.some((item) => item.source === direct.source && String(item.sourceEntityId) === String(direct.sourceEntityId))) {
      mappings.push(direct);
    }
    if (source === 'AppDynamics' && !mappings.some((item) => canonicalSource(item.source) === source)) {
      const applicationName = cleanText(alert.sourceMetadata?.appDynamicsApplicationName);
      if (applicationName && appDynamics.getApplicationIdentityInventory) {
        if (appDynamicsIdentityCache.expiresAt <= now()) {
          const inventory = await appDynamics.getApplicationIdentityInventory({ refresh: false });
          appDynamicsIdentityCache = {
            expiresAt: now() + 5 * 60 * 1000,
            applications: Array.isArray(inventory?.applications) ? inventory.applications : [],
          };
        }
        const matches = appDynamicsIdentityCache.applications.filter((item) => cleanText(item.name).toLowerCase() === applicationName.toLowerCase());
        if (matches.length === 1) mappings.push({
          source: 'AppDynamics', level: 'EXACT', confidence: 100,
          sourceEntityId: String(matches[0].id), sourceEntityName: matches[0].name,
          sourceEntityType: 'APPLICATION', metadata: {
            applicationId: String(matches[0].id), sourceAlertId: alert.sourceMetadata?.appDynamicsSourceAlertId || null,
          },
          reasons: ['Exact AppDynamics application name resolved against the read-only application inventory'],
          provenance: [{ field: 'application', source: 'JSM Operations source metadata' }, { field: 'applicationId', source: 'AppDynamics application inventory' }],
        });
      }
    }
    return mappings;
  }

  async function experimentPrediction(alertId) {
    const result = await database.query(`
      SELECT prediction.model_version, prediction.incident_risk_score, prediction.score_band
      FROM ml_shadow_predictions prediction
      JOIN ml_shadow_experiments experiment ON experiment.experiment_id = prediction.experiment_id
      WHERE prediction.alert_id = $1
      ORDER BY experiment.created_at DESC, prediction.created_at DESC LIMIT 1
    `, [alertId]);
    if (!result.rows[0]) return null;
    return {
      modelVersion: result.rows[0].model_version,
      incidentRiskScore: Number(result.rows[0].incident_risk_score),
      scoreBand: result.rows[0].score_band,
      experimentalOnly: true,
    };
  }

  async function queryAdapter(adapter, alert, window, context) {
    const sourceInstance = adapter.source === 'Grafana'
      ? cleanText(alert?.sourceMetadata?.grafanaSourceHost || 'configured-workspace')
      : adapter.source === 'Nagios'
        ? cleanText(context?.mappings?.find((item) => canonicalSource(item?.source) === 'Nagios')?.metadata?.instance
          || alert?.sourceMetadata?.nagiosEnvironment || 'configured-instances')
        : 'default';
    const circuitKey = `${adapter.source}:${sourceInstance}`;
    const circuit = sourceCircuits.get(circuitKey) || { failures: 0, openUntil: 0 };
    if (circuit.openUntil > now()) {
      return {
        source: adapter.source,
        adapter: `${adapter.source.replace(/\s+/g, '')}EvidenceAdapter`,
        status: 'error', pipelineState: 'QUERY_FAILED', evidence: [], relationships: [],
        failureReason: 'SOURCE_CIRCUIT_OPEN', readOnly: true, executionTimeMs: 0,
        query: { circuitOpenUntil: new Date(circuit.openUntil).toISOString() },
      };
    }
    const timeoutMs = adapter.source === 'AppDynamics' ? APPDYNAMICS_EVALUATION_TIMEOUT_MS
      : adapter.source === 'Grafana' ? GRAFANA_EVALUATION_TIMEOUT_MS
      : adapter.source === 'Nagios' ? NAGIOS_EVALUATION_TIMEOUT_MS : EVALUATION_TIMEOUT_MS;
    const result = await withTimeout(
      adapter.queryEvidence(alert, window, context), timeoutMs, adapter.source,
    );
    const expectedConfigurationBlocker = result.failureReason === 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED';
    if ((result.pipelineState === 'QUERY_FAILED' || result.status === 'error') && !expectedConfigurationBlocker) {
      const failures = circuit.failures + 1;
      sourceCircuits.set(circuitKey, {
        failures,
        openUntil: failures >= CIRCUIT_FAILURE_THRESHOLD ? now() + CIRCUIT_OPEN_MS : 0,
      });
    } else if (!expectedConfigurationBlocker) {
      sourceCircuits.set(circuitKey, { failures: 0, openUntil: 0 });
    }
    return result;
  }

  async function evaluate(alertId, options = {}) {
    await ensureSchema();
    const startedAt = now();
    const requestId = cleanText(options.requestId) || `eval-request-${hash(`${alertId}|${startedAt}|${Math.random()}`)}`;
    const [record, initialStored, priorPhase13] = await Promise.all([
      learning.get(alertId), storedAlert(alertId), phase13Evaluation(alertId),
    ]);
    if (!initialStored) {
      const error = new Error(`Stored alert ${alertId} was not found.`);
      error.status = 404;
      throw error;
    }
    const stored = await enrichMonitoringStoredAlert(record, initialStored);
    const source = monitoringSourceFromRecord(record, stored);
    const replayEpisodeContext = options.persist === false && options.episodeContextOverride
      && typeof options.episodeContextOverride === 'object'
      ? options.episodeContextOverride : null;
    const [legacyNotificationRelationship, episodeContext] = await Promise.all([
      notificationRelationship(alertId, source),
      replayEpisodeContext || episodeLayer.contextForAlert(alertId, { refresh: options.refresh === true }),
    ]);
    const occurrenceAwareContext = episodeContext
      && episodeContext.episodeGroupingBasis !== 'TIME_WINDOW_ONLY'
      && episodeContext.legacyGroupingDisposition !== 'LEGACY_GROUPING_REQUIRES_REPLAY';
    // The legacy relationship is built from overlapping signature/entity time
    // windows. It remains available only for preserved pre-activation alerts;
    // corrected grouping never uses it as Repeat or Duplicate proof.
    record.notificationRelationship = occurrenceAwareContext ? null : legacyNotificationRelationship;
    record.episodeContext = episodeContext;
    const alert = buildAlertContext(record, stored);
    const mappings = await validatedMappings(record, alert);
    const occurrenceAt = new Date(record.temporalFeatures?.createdAt || record.featureAsOf || startedAt).getTime();
    const replayStart = Number.isFinite(occurrenceAt) ? occurrenceAt : startedAt;
    const windowEnd = Math.min(startedAt, replayStart + MAX_EVALUATION_WINDOW_MS);
    const windowStart = Math.max(replayStart - 30 * 60 * 1000, windowEnd - MAX_EVALUATION_WINDOW_MS);
    const featureAsOf = new Date(windowEnd).toISOString();
    const window = { from: new Date(windowStart).toISOString(), to: new Date(windowEnd).toISOString(), beforeMinutes: 30, afterMinutes: 30 };

    const persistedOccurrence = await loadOccurrenceObservation(database, {
      alertId,
      source,
      alert,
    });
    const monitoringSources = unique([
      source,
      ...mappings.map((mapping) => canonicalSource(mapping.source)),
    ]).filter((item) => SUPPORTED_SOURCES.includes(item));
    const selectedAdapters = monitoringSources.map((name) => adapters.get(name)).filter(Boolean)
      .filter((adapter) => !(persistedOccurrence.blocksFreshSourceQuery && adapter.source === source));
    const jiraAdapter = adapters.get('ACC Jira');
    const slackAdapter = adapters.get('Slack');
    const context = { mappings, range: '24h', refresh: options.refresh === true };
    const queriedBlocks = await Promise.all([
      ...selectedAdapters.map((adapter) => queryAdapter(adapter, alert, window, context)),
      jiraAdapter ? queryAdapter(jiraAdapter, alert, window, context) : null,
      slackAdapter ? queryAdapter(slackAdapter, alert, window, context) : null,
    ].filter(Boolean));
    const blocks = mergeOccurrenceEvidence(queriedBlocks, persistedOccurrence);
    const occurrenceFreshness = occurrenceEvidenceFreshness(
      persistedOccurrence,
      new Date(startedAt).toISOString(),
    );
    const lifecycleObservationTimes = [
      featureAsOf,
      persistedOccurrence.evidence?.metadata?.recoveryAt,
      persistedOccurrence.evidence?.metadata?.observedAt,
    ].map((value) => value ? new Date(value).getTime() : Number.NaN)
      .filter(Number.isFinite)
      .map((value) => Math.min(value, startedAt));
    const evidenceFeatureAsOf = new Date(Math.max(...lifecycleObservationTimes)).toISOString();

    const technicalEvidence = technicalEvidenceContract(source, alert, blocks);
    technicalEvidence.occurrenceEvidenceConsumption = {
      matchingWindow: window,
      lifecycleObservationAsOf: evidenceFeatureAsOf,
      persistedExactOccurrenceAccepted: persistedOccurrence.accepted,
      persistedTerminalLifecycleAccepted: persistedOccurrence.terminal,
      persistedEvidenceReason: persistedOccurrence.reason,
      externalSourceQuerySkipped: persistedOccurrence.blocksFreshSourceQuery,
      freshness: occurrenceFreshness,
      readOnly: true,
    };
    technicalEvidence.coverage = buildSourceEvidenceCoverage({
      source,
      originalSource: alert.sourceMetadata?.originalSource || alert.source,
      technicalEvidence,
      blocks,
      mappings,
      retrievedAt: new Date(now()).toISOString(),
    });
    const historicalProfile = source
      ? await loadHistoricalProfile(database, {
          alertId,
          source,
          sourceIdentity: record.sourceIdentity || {},
          alertSignature: record.alertSignature || record.alert?.alertSignature || null,
        })
      : { windowDays: 90, historyStatus: 'INSUFFICIENT_HISTORY', occurrenceCount: 0 };
    technicalEvidence.monitoringLifecycle = buildMonitoringLifecycle({
      record, alert, source, blocks, technicalEvidence, historicalProfile, featureAsOf: evidenceFeatureAsOf,
    });
    const featureSnapshot = buildFeatureSnapshot(record, technicalEvidence, evidenceFeatureAsOf);
    featureSnapshot.monitoringLifecycle = technicalEvidence.monitoringLifecycle;
    featureSnapshot.episode = episodeContext;
    technicalEvidence.episode = episodeContext;
    const decisionStartedAt = now();
    const unified = evaluateUnifiedEvidence({ record, blocks, technicalEvidence, source, featureAsOf: evidenceFeatureAsOf });
    const decisionTimeMs = Math.max(0, now() - decisionStartedAt);
    const shadowPrediction = await experimentPrediction(alertId);
    const noiseDetection = unified.noiseDetection;
    const classification = unified.classification;
    const evidenceReferences = blocks.flatMap((block) => (block.evidence || [])
      .slice(-MAX_EVIDENCE_REFERENCES_PER_SOURCE).map((item) => ({
      id: item.id, source: item.source, type: item.type, timestamp: item.timestamp, url: item.url || null,
      provenance: item.metadata?.retrievalStatus || 'READ_ONLY_SOURCE_EVIDENCE',
    })));
    if (record.notificationRelationship) {
      evidenceReferences.push({
        id: `jsm-notification-relationship:${alertId}`,
        source: 'JSM Operations',
        type: record.notificationRelationship.duplicateOf
          ? 'duplicate_notification_relationship' : 'primary_notification_relationship',
        timestamp: evidenceFeatureAsOf,
        url: null,
        provenance: record.notificationRelationship.relationshipMethod,
      });
    }
    const oldDimensions = priorPhase13 ? {
      noiseDetection: priorPhase13.noise_detection || {},
      classification: priorPhase13.classification || {},
      businessImpact: priorPhase13.business_impact,
      actionability: priorPhase13.actionability,
      underlyingEvent: priorPhase13.underlying_event,
      notificationRole: priorPhase13.notification_role,
    } : null;
    const newDimensions = {
      noiseDetection: unified.noiseDetection,
      classification: unified.classification,
      businessImpact: unified.businessImpact,
      actionability: unified.actionability,
      underlyingEvent: unified.underlyingEvent,
      notificationRole: unified.notificationRole,
    };
    const recommendationChanged = Boolean(priorPhase13
      && priorPhase13.final_decision !== unified.finalDecision);
    const decisionChange = recommendationChanged ? {
      alertId,
      oldDecision: priorPhase13.final_decision,
      newDecision: unified.finalDecision,
      oldDimensions,
      newDimensions,
      reasonForChange: unified.explanation?.reasons || [],
      evidenceReferences,
      policyVersion: unified.decisionPolicy,
    } : null;
    const reviewPriority = unified.finalDecision === 'NOISE' ? 1
      : recommendationChanged ? 2 : unified.finalDecision === 'INCIDENT' ? 3 : 4;
    const failureReasons = unique([
      !source ? 'SUPPORTED_MONITORING_EVIDENCE_UNAVAILABLE' : null,
      ...blocks.filter((block) => block.failureReason).map((block) => `${block.source}:${block.failureReason}`),
      ...unified.failureReasons,
    ]);
    const evidenceUsed = unique([
      ...evidenceReferences.map((item) => `${item.source}: ${item.type}`),
      ...(unified.explanation?.dimensionDetails
        ? Object.values(unified.explanation.dimensionDetails).flatMap((item) => item?.reason || []) : []),
    ]);
    const evidenceMissing = unique([
      ...failureReasons,
      ...(technicalEvidence.coverage?.evidenceCompleteness?.missingFields || []).map((field) => `Missing ${field}`),
      !record.sourceIdentity?.entity && !record.sourceIdentity?.entityId ? 'Source entity identity unavailable' : null,
      !record.jiraIncident?.jiraIncidentKey ? 'No confirmed Jira Incident relationship' : null,
      !Number(record.slackFeatures?.slackMessageCount || 0) ? 'No correlated Slack context' : null,
    ]);
    const evaluationId = `live-eval-${hash(`${alertId}|${evidenceFeatureAsOf}|${requestId}`)}`;
    const evaluationTimeMs = Math.max(0, now() - startedAt);
    const values = {
      evaluationId, requestId, alertId, source: source || 'Unsupported/Unknown', sourceAlertId: record.alert.sourceAlertId,
      featureAsOf: evidenceFeatureAsOf, modelVersion: MODEL_VERSION, releaseStatus: RELEASE_STATUS,
      finalDecision: unified.finalDecision, confidence: null,
      experimentalRisk: shadowPrediction?.incidentRiskScore ?? null,
      evidenceScore: unified.evidenceScore, decisionConfidence: unified.decisionConfidence,
      decisionPolicy: unified.decisionPolicy, evaluationStatus: unified.evaluationStatus,
      businessImpact: unified.businessImpact, actionability: unified.actionability,
      underlyingEvent: unified.underlyingEvent, notificationRole: unified.notificationRole,
      noiseDetection, classification, featureSnapshot, technicalEvidence,
      evidenceVector: unified.evidenceVector, sourceDetails: unified.sourceDetails,
      sourceProvenance: unified.sourceProvenance,
      evidenceReferences, explanation: {
        ...unified.explanation,
        decisionChange,
        phase13Baseline: priorPhase13 ? {
          evaluationId: priorPhase13.evaluation_id,
          decision: priorPhase13.final_decision,
          dimensions: oldDimensions,
          evaluatedAt: toIso(priorPhase13.created_at),
        } : null,
        reviewPriority,
        evidenceUsed,
        evidenceMissing,
        evidenceScores: unified.evidenceScores,
        experimentalModelVersion: shadowPrediction?.modelVersion || null,
        experimentalScoreApproved: false,
      },
      adapterDiagnostics: blocks.map((block) => ({
        source: block.source, adapter: block.adapter, status: block.status,
        pipelineState: block.pipelineState, failureReason: block.failureReason,
        executionTimeMs: block.executionTimeMs, recordsReturned: block.recordsReturned,
        matchedRecords: block.matchedRecords, readOnly: block.readOnly !== false,
        query: safeDiagnosticQuery(block.query || null),
      })),
      failureReasons,
      evaluationTimeMs,
      observability: {
        requestId, alertId, source: source || 'Unsupported/Unknown',
        sourceAdapters: blocks.map((block) => block.adapter),
        sourceApiDurationMs: Object.fromEntries(blocks.map((block) => [block.source, Number(block.executionTimeMs || 0)])),
        evidenceCount: evidenceReferences.length,
        evidenceCompleteness: unified.evidenceVector.dataCompleteness?.score ?? null,
        evidenceFreshness: occurrenceFreshness,
        decisionDurationMs: decisionTimeMs,
        finalRecommendation: unified.finalDecision,
        modelVersion: MODEL_VERSION,
        decisionPolicy: unified.decisionPolicy,
        failureReasons,
      },
    };
    if (options.persist === false) {
      return {
        ...values,
        alert: {
          id: record.alert.alertId, sourceAlertId: record.alert.sourceAlertId,
          title: stored.title, message: record.alert.message, severity: record.alert.severity,
          priority: record.alert.priority, status: record.alert.status,
        },
        context: {
          sourceIdentity: record.sourceIdentity,
          jiraIncident: record.jiraIncident,
          jiraProblem: record.jiraProblem,
          slack: record.slackFeatures,
          observedBehavior: record.observedBehavior,
          historicalContext: featureSnapshot.historicalContext,
          episode: featureSnapshot.episode,
        },
        persisted: false,
        guarantees: {
          shadowOnly: true, noSourceMutations: true, noSelfLabeling: true,
          predictionIsTrainingLabel: false, confidenceCalibrated: false,
        },
      };
    }
    const inserted = await database.query(`
      INSERT INTO live_shadow_evaluations (
        evaluation_id, request_id, alert_id, source, source_alert_id, feature_as_of,
        model_version, model_release_status, final_decision, confidence,
        experimental_incident_risk_score, business_impact, actionability,
        underlying_event, notification_role, noise_detection, classification,
        feature_snapshot, technical_evidence, evidence_references, explanation,
        adapter_diagnostics, failure_reasons, evaluation_time_ms, source_mutations,
        evidence_score, decision_confidence, decision_policy, evaluation_status,
        feedback_status, evidence_vector, source_details, source_provenance, observability
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,
        $18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,$24,0,
        $25,$26,$27,$28,'UNLABELED',$29::jsonb,$30::jsonb,$31::jsonb,$32::jsonb
      ) RETURNING *
    `, [
      values.evaluationId, values.requestId, values.alertId, values.source, values.sourceAlertId,
      values.featureAsOf, values.modelVersion, values.releaseStatus, values.finalDecision, values.confidence,
      values.experimentalRisk, values.businessImpact, values.actionability, values.underlyingEvent,
      values.notificationRole, JSON.stringify(values.noiseDetection), JSON.stringify(values.classification),
      JSON.stringify(values.featureSnapshot), JSON.stringify(values.technicalEvidence),
      JSON.stringify(values.evidenceReferences), JSON.stringify(values.explanation),
      JSON.stringify(values.adapterDiagnostics), JSON.stringify(values.failureReasons), values.evaluationTimeMs,
      values.evidenceScore, values.decisionConfidence, values.decisionPolicy, values.evaluationStatus,
      JSON.stringify(values.evidenceVector), JSON.stringify(values.sourceDetails),
      JSON.stringify(values.sourceProvenance), JSON.stringify(values.observability),
    ]);
    // The supervised model is advisory and isolated from the deterministic
    // transaction. A missing model or prediction failure must never change,
    // delay, or roll back the authoritative evaluation above.
    let mlRecommendation = { status: 'NOT_ATTEMPTED', predictionStored: false };
    try {
      mlRecommendation = await mlShadowService.predictEvaluation(inserted.rows[0]);
    } catch (error) {
      mlRecommendation = {
        status: 'SHADOW_PREDICTION_FAILED',
        predictionStored: false,
        safeError: cleanText(error.code || error.message || 'Shadow prediction failed.'),
      };
    }
    let evidencePatternRecommendation = {
      status: 'NOT_ATTEMPTED', recommendation: 'NEEDS_REVIEW', shadowOnly: true,
    };
    if (patternLearning) {
      try {
        evidencePatternRecommendation = {
          status: 'STORED',
          ...(await patternLearning.recommendationForEvaluation(inserted.rows[0])),
        };
      } catch (error) {
        evidencePatternRecommendation = {
          status: 'SHADOW_RECOMMENDATION_FAILED', recommendation: 'NEEDS_REVIEW',
          shadowOnly: true, safeError: cleanText(error.code || error.message || 'Pattern recommendation failed.'),
        };
      }
    }
    const verificationDelivery = humanVerificationService.queueEvaluation(inserted.rows[0]);
    episodeLayer.invalidate?.();
    return {
      ...mapEvaluation(inserted.rows[0]),
      mlRecommendation,
      evidencePatternRecommendation,
      verificationDelivery,
      alert: {
        id: record.alert.alertId, sourceAlertId: record.alert.sourceAlertId,
        title: stored.title, message: record.alert.message, severity: record.alert.severity,
        priority: record.alert.priority, status: record.alert.status,
      },
      context: {
        sourceIdentity: record.sourceIdentity,
        jiraIncident: record.jiraIncident,
        jiraProblem: record.jiraProblem,
        slack: record.slackFeatures,
        observedBehavior: record.observedBehavior,
        historicalContext: featureSnapshot.historicalContext,
        episode: featureSnapshot.episode,
      },
      guarantees: {
        shadowOnly: true, noSourceMutations: true, noSelfLabeling: true,
        predictionIsTrainingLabel: false, confidenceCalibrated: false,
      },
    };
  }

  async function listCandidates(options = {}) {
    await ensureSchema();
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || options.size) || 25));
    const canonicalSourceSql = `CASE
      WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'appd%' THEN 'AppDynamics'
      WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'grafana%' THEN 'Grafana'
      WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'nagios%' THEN 'Nagios'
      WHEN REPLACE(LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)), ' ', '') LIKE 'thousandeyes%' THEN 'ThousandEyes'
      ELSE NULL END`;
    const evaluableSql = `COALESCE(
      (evaluation.technical_evidence->'coverage'->'evaluability'->>'evaluable')::boolean,
      false
    )`;
    const clauses = [
      'alert.atlassian_ops_alert_id IS NOT NULL',
      commandCenterAlertSql('alert'),
    ];
    const values = [];
    const range = cleanText(options.range || '24h').toLowerCase();
    const hours = range === '7d' ? 168 : range === '30d' ? 720 : 24;
    values.push(hours);
    clauses.push(`alert.received_at >= NOW() - ($${values.length}::text || ' hours')::interval`);
    if (options.source) {
      const requestedSource = canonicalSource(options.source);
      if (requestedSource) {
        values.push(requestedSource);
        clauses.push(`${canonicalSourceSql} = $${values.length}`);
      } else if (/unsupported|unknown/i.test(cleanText(options.source))) {
        clauses.push(`${canonicalSourceSql} IS NULL`);
      }
    }
    if (options.search) {
      values.push(`%${cleanText(options.search).toLowerCase()}%`);
      clauses.push(`(LOWER(alert.title) LIKE $${values.length} OR LOWER(alert.description) LIKE $${values.length} OR LOWER(COALESCE(alert.source_alert_id,'')) LIKE $${values.length})`);
    }
    const requestedDecision = cleanText(options.decision).toUpperCase();
    if (['NOISE', 'INCIDENT', 'NEEDS_REVIEW'].includes(requestedDecision)) {
      values.push(requestedDecision);
      clauses.push(`evaluation.final_decision = $${values.length}`);
    }
    const requestedClassification = cleanText(options.classification).toUpperCase();
    if (requestedClassification) {
      values.push(requestedClassification);
      clauses.push(`COALESCE(evaluation.classification->>'domain','UNKNOWN') = $${values.length}`);
    }
    const requestedNoiseType = cleanText(options.noiseType).toUpperCase();
    if (requestedNoiseType) {
      values.push(requestedNoiseType);
      clauses.push(`(COALESCE(evaluation.noise_detection->>'primary','UNKNOWN') = $${values.length}
        OR COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? $${values.length})`);
    }
    const requestedEvidence = cleanText(options.evidence).toUpperCase();
    if (requestedEvidence === 'COMPLETE') {
      clauses.push(`COALESCE((evaluation.technical_evidence->'coverage'->'evidenceCompleteness'->>'complete')::boolean, false)`);
    } else if (requestedEvidence === 'INCOMPLETE') {
      clauses.push(`NOT COALESCE((evaluation.technical_evidence->'coverage'->'evidenceCompleteness'->>'complete')::boolean, false)`);
    }
    const requestedReviewed = cleanText(options.reviewed).toUpperCase();
    if (requestedReviewed === 'REVIEWED') clauses.push('outcome.id IS NOT NULL');
    else if (requestedReviewed === 'UNREVIEWED') clauses.push('outcome.id IS NULL');
    const requestedFeedback = cleanText(options.feedback).toUpperCase();
    if (requestedFeedback === 'UNCONFIRMED') clauses.push('outcome.id IS NULL');
    else if (['CONFIRMED_NOISE', 'CONFIRMED_INCIDENT', 'UNKNOWN'].includes(requestedFeedback)) {
      values.push(requestedFeedback);
      clauses.push(`outcome.outcome = $${values.length}`);
    }
    if (String(options.goldReview || '').toLowerCase() === 'true') {
      clauses.push('evaluation.evaluation_id IS NOT NULL');
      clauses.push('outcome.id IS NULL');
      clauses.push(evaluableSql);
    }
    const filteredValues = [...values];
    values.push((page - 1) * pageSize, pageSize);
    const [result, summaryResult, sourceSummaryResult, coverageResult] = await Promise.all([database.query(`
      SELECT alert.id, alert.title, alert.description, alert.source, alert.source_alert_id,
        alert.atlassian_ops_tiny_id, alert.source_url, alert.jira_ticket_id,
        alert.severity, alert.status, alert.environment, alert.service, alert.received_at,
        alert.acknowledged,
        COALESCE(alert.raw_payload->'priority'->>'name', alert.raw_payload->>'priority',
          alert.raw_payload->>'priorityName', alert.extracted_details->>'priority') AS priority,
        ${canonicalSourceSql} AS monitoring_source,
        COUNT(*) OVER() AS total_count,
        evaluation.evaluation_id, evaluation.final_decision, evaluation.feature_as_of,
        evaluation.model_release_status, evaluation.evidence_score, evaluation.decision_policy,
        evaluation.decision_confidence, evaluation.evaluation_status,
        evaluation.observability->>'sourceMutations' AS source_mutations,
        evaluation.observability->>'evidenceCount' AS evidence_count,
        evaluation.technical_evidence->'provenance'->>'primaryStatus' AS technical_status,
        evaluation.technical_evidence->'provenance'->>'primaryFailureReason' AS technical_failure,
        evaluation.technical_evidence->>'deepLink' AS monitoring_url,
        evaluation.noise_detection, evaluation.classification, evaluation.business_impact,
        evaluation.actionability, evaluation.underlying_event, evaluation.notification_role,
        evaluation.feedback_status, evaluation.created_at AS evaluation_created_at,
        GREATEST(appd_occurrence.observed_at, grafana_occurrence.observed_at,
          nagios_occurrence.observed_at) AS source_evidence_retrieved_at,
        GREATEST(appd_occurrence.updated_at, grafana_occurrence.updated_at,
          nagios_occurrence.updated_at) AS persisted_occurrence_updated_at,
        GREATEST(appd_occurrence.recovery_at, grafana_occurrence.recovery_at,
          nagios_occurrence.recovery_at) AS lifecycle_terminal_at,
        ${OCCURRENCE_EVIDENCE_REVISION_SQL} AS latest_source_evidence_at,
        CASE WHEN evaluation.created_at IS NOT NULL
          AND ${OCCURRENCE_EVIDENCE_REVISION_SQL} > evaluation.created_at
          THEN true ELSE false END AS evaluation_stale,
        evaluation.technical_evidence, evaluation.adapter_diagnostics,
        evaluation.feature_snapshot->'identity' AS source_identity,
        evaluation.feature_snapshot->'episode' AS episode_context,
        evaluation.feature_snapshot->'operationalPriority' AS operational_priority,
        evaluation.technical_evidence->'monitoringLifecycle' AS monitoring_lifecycle,
        evaluation.explanation,
        COALESCE(alert.raw_payload->>'source', alert.raw_payload->>'integrationName', alert.source) AS original_source,
        outcome.outcome AS confirmed_outcome, outcome.reason AS feedback_reason,
        outcome.reason_code AS feedback_reason_code, outcome.recorded_at AS feedback_recorded_at,
        outcome.recorded_by AS feedback_recorded_by, outcome.linked_incident_key,
        (SELECT incident.source_url FROM operations_incidents incident
          WHERE incident.incident_key = COALESCE(outcome.linked_incident_key, alert.jira_ticket_id)
          LIMIT 1) AS incident_url
      FROM alerts alert
      LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
      ${OCCURRENCE_EVIDENCE_JOINS_SQL}
      LEFT JOIN alert_occurrence_outcomes outcome ON outcome.alert_id = alert.id AND outcome.is_current
      WHERE ${clauses.join(' AND ')}
      ORDER BY alert.received_at DESC, alert.id DESC
      OFFSET $${values.length - 1} LIMIT $${values.length}
    `, values), database.query(`
      SELECT COUNT(*)::int AS total_alerts,
        COUNT(evaluation.evaluation_id)::int AS evaluated,
        COUNT(evaluation.evaluation_id)::int AS decision_population,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE')::int AS noise,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'INCIDENT')::int AS incident,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW')::int AS needs_review,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision' = 'INCIDENT'
          AND evaluation.final_decision = 'NOISE')::int AS incident_to_noise,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision' = 'INCIDENT'
          AND evaluation.final_decision = 'NEEDS_REVIEW')::int AS incident_to_review,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision' = 'NEEDS_REVIEW'
          AND evaluation.final_decision = 'INCIDENT')::int AS review_to_incident,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision' = 'NEEDS_REVIEW'
          AND evaluation.final_decision = 'NOISE')::int AS review_to_noise,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision' = 'NOISE'
          AND evaluation.final_decision = 'INCIDENT')::int AS noise_to_incident,
        COUNT(*) FILTER (WHERE evaluation.explanation->'decisionChange'->>'oldDecision' = 'NOISE'
          AND evaluation.final_decision = 'NEEDS_REVIEW')::int AS noise_to_review,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND COALESCE((evaluation.explanation->>'evidenceExhausted')::boolean, false))::int AS review_evidence_exhausted,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND jsonb_array_length(COALESCE(evaluation.explanation->'decisionBlockers', '[]'::jsonb)) > 0)::int AS review_with_blocker,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND NULLIF(evaluation.explanation->>'reviewQuestion', '') IS NOT NULL)::int AS review_with_question,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND COALESCE((evaluation.explanation->'qualityAudit'->>'noiseEvidenceProvenance')::boolean, false))::int AS noise_with_provenance,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND COALESCE((evaluation.explanation->'noiseEvidence'->>'mustHavePositiveSignal')::boolean, false))::int AS noise_with_positive_evidence,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND NOT COALESCE((evaluation.explanation->'noiseEvidence'->>'mustHavePositiveSignal')::boolean, false))::int AS noise_without_positive_evidence,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND NULLIF(evaluation.explanation->>'whyNoise', '') IS NOT NULL)::int AS noise_with_reason,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND jsonb_array_length(COALESCE(evaluation.explanation->'noiseEvidence'->'contradictoryEvidence', '[]'::jsonb)) > 0)::int AS potential_lifecycle_contradictions,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'AUTO_RESOLVED'
          AND (evaluation.explanation->'stateSemantics'->>'monitoringOccurrenceLifecycle' <> 'RECOVERED'
            OR NOT COALESCE((evaluation.explanation->'noiseEvidence'->>'mustHavePositiveSignal')::boolean, false)))::int AS potential_false_auto_resolved,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'NON_ACTIONABLE'
          AND NOT COALESCE((evaluation.noise_detection->'detectors'->'NON_ACTIONABLE'->>'observed')::boolean, false))::int AS non_actionable_detector_inconsistencies,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND COALESCE((evaluation.explanation->'qualityAudit'->>'ignoredContradictoryIncidentEvidence')::boolean, false))::int AS noise_with_ignored_contradiction,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'INCIDENT'
          AND COALESCE((evaluation.explanation->'qualityAudit'->>'incidentPositiveEvidence')::boolean, false))::int AS incident_with_positive_evidence,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.explanation->>'fallbackEvidenceUsed')::boolean, false))::int AS source_api_evidence_gaps,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.explanation->>'fallbackResolved')::boolean, false))::int AS fallback_resolved,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND COALESCE((evaluation.explanation->>'genuinelyAmbiguous')::boolean, false))::int AS genuinely_ambiguous,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND evaluation.explanation->>'reviewSubReason' = 'AWAITING_LIFECYCLE_EVIDENCE')::int AS review_awaiting_lifecycle,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND evaluation.explanation->>'reviewSubReason' = 'SOURCE_EVIDENCE_UNAVAILABLE')::int AS review_source_unavailable,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND evaluation.explanation->>'reviewSubReason' = 'LIFECYCLE_CONFLICT')::int AS review_lifecycle_conflict,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND evaluation.explanation->>'reviewSubReason' = 'IDENTITY_AMBIGUITY')::int AS review_identity_ambiguity,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND evaluation.explanation->>'reviewSubReason' = 'EVIDENCE_CONFLICT')::int AS review_evidence_conflict,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND COALESCE(evaluation.explanation->>'reviewSubReason','OTHER') NOT IN (
            'AWAITING_LIFECYCLE_EVIDENCE','SOURCE_EVIDENCE_UNAVAILABLE','LIFECYCLE_CONFLICT',
            'IDENTITY_AMBIGUITY','EVIDENCE_CONFLICT','GENUINELY_AMBIGUOUS'
          ))::int AS review_other,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW'
          AND COALESCE((evaluation.explanation->>'fallbackEvidenceUsed')::boolean, false)
          AND jsonb_array_length(COALESCE(evaluation.explanation->'decisionBlockers', '[]'::jsonb)) = 1
          AND evaluation.explanation->'decisionBlockers'->0->>'field' = 'Authoritative monitoring state')::int AS source_unavailable_only_reviews,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL AND COALESCE(evaluation.noise_detection->>'primary','UNKNOWN') <> 'UNKNOWN')::int AS noise_detection_covered,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL AND COALESCE(evaluation.classification->>'domain','UNKNOWN') NOT IN ('UNKNOWN','UNKNOWN_DOMAIN'))::int AS classification_covered,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL AND evaluation.business_impact <> 'UNKNOWN')::int AS business_impact_covered,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL AND evaluation.actionability <> 'UNKNOWN')::int AS actionability_covered,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL AND evaluation.underlying_event <> 'UNKNOWN')::int AS underlying_event_covered,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL AND evaluation.notification_role <> 'UNKNOWN')::int AS notification_role_covered,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'DUPLICATE')::int AS duplicate,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'FLAPPING')::int AS flapping,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'AUTO_RESOLVED')::int AS auto_resolved,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'NON_ACTIONABLE')::int AS non_actionable,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'OPERATIONALLY_NON_ACTIONABLE')::int AS operationally_non_actionable,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'CORRELATED')::int AS correlated,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.noise_detection->'observed','[]'::jsonb) ? 'STALE')::int AS stale,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'duplicateCandidate')::boolean, false))::int AS duplicate_candidate,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'duplicateConfirmed')::boolean, false))::int AS duplicate_confirmed,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'correlationCandidate')::boolean, false))::int AS correlation_candidate,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'correlationConfirmed')::boolean, false))::int AS correlation_confirmed,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'historicalBehavior'->>'occurrenceCount')::int, 0) >= 1)::int AS alerts_with_prior_occurrence,
        COUNT(*) FILTER (WHERE evaluation.technical_evidence->'monitoringLifecycle'->'historicalBehavior'->>'historyStatus' = 'SUFFICIENT_HISTORY')::int AS sufficient_history,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'completeness'->>'historicalEvidenceAvailable')::boolean, false))::int AS historical_profiles,
        COUNT(*) FILTER (WHERE COALESCE(evaluation.technical_evidence->'monitoringLifecycle'->'signals','[]'::jsonb) ?| ARRAY['ABNORMAL_DURATION','ABNORMAL_METRIC','ABNORMAL_SEVERITY'])::int AS abnormal_history,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'intervention'->>'acknowledged')::boolean, false))::int AS intervention_acknowledged,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'intervention'->>'investigated')::boolean, false))::int AS intervention_investigated,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'intervention'->>'remediated')::boolean, false))::int AS intervention_remediated,
        COUNT(*) FILTER (WHERE COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'intervention'->>'escalated')::boolean, false))::int AS intervention_escalated,
        COUNT(*) FILTER (WHERE evaluation.evaluation_id IS NOT NULL
          AND NOT COALESCE((evaluation.technical_evidence->'monitoringLifecycle'->'intervention'->>'operatorActionObserved')::boolean, false))::int AS no_intervention_observed,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'DUPLICATE')::int AS noise_duplicate,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'REPEAT')::int AS noise_repeat,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'FLAPPING')::int AS noise_flapping,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'AUTO_RESOLVED')::int AS noise_auto_resolved,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'NON_ACTIONABLE')::int AS noise_non_actionable,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'OPERATIONALLY_NON_ACTIONABLE')::int AS noise_operationally_non_actionable,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'CORRELATED')::int AS noise_correlated,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' = 'STALE')::int AS noise_stale,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE'
          AND evaluation.explanation->>'noiseType' IN ('INFORMATIONAL', 'INFORMATIONAL_PRIORITY'))::int AS noise_informational_priority,
        COUNT(*) FILTER (WHERE ${evaluableSql} AND outcome.id IS NULL)::int AS gold_review_eligible,
        COUNT(*) FILTER (WHERE evaluation.technical_evidence->'provenance'->>'primaryStatus' = 'working')::int AS source_covered,
        COUNT(*) FILTER (WHERE outcome.outcome = 'CONFIRMED_NOISE')::int AS confirmed_noise,
        COUNT(*) FILTER (WHERE outcome.outcome = 'CONFIRMED_INCIDENT')::int AS confirmed_incident,
        COUNT(*) FILTER (WHERE outcome.outcome = 'UNKNOWN')::int AS confirmed_unknown,
        COUNT(*) FILTER (WHERE outcome.id IS NULL)::int AS unconfirmed,
        MAX(COALESCE(evaluation.created_at, alert.updated_at, alert.received_at)) AS last_updated
      FROM alerts alert
      LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
      LEFT JOIN alert_occurrence_outcomes outcome ON outcome.alert_id = alert.id AND outcome.is_current
      WHERE ${clauses.join(' AND ')}
    `, filteredValues), database.query(`
      SELECT ${canonicalSourceSql} AS source,
        COUNT(*)::int AS total_alerts,
        COUNT(evaluation.evaluation_id)::int AS evaluated,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'INCIDENT')::int AS incident,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NOISE')::int AS noise,
        COUNT(*) FILTER (WHERE evaluation.final_decision = 'NEEDS_REVIEW')::int AS needs_review,
        COUNT(*) FILTER (WHERE evaluation.technical_evidence->'provenance'->>'primaryStatus' = 'working')::int AS source_covered
      FROM alerts alert
      LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
      LEFT JOIN alert_occurrence_outcomes outcome ON outcome.alert_id = alert.id AND outcome.is_current
      WHERE ${clauses.join(' AND ')}
      GROUP BY 1 ORDER BY 1
    `, filteredValues), database.query(`
      SELECT alert.id, ${canonicalSourceSql} AS source,
        COALESCE(alert.raw_payload->>'source', alert.raw_payload->>'integrationName', alert.source) AS original_source,
        evaluation.evaluation_id, evaluation.noise_detection,
        evaluation.technical_evidence, evaluation.adapter_diagnostics
      FROM alerts alert
      LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
      LEFT JOIN alert_occurrence_outcomes outcome ON outcome.alert_id = alert.id AND outcome.is_current
      WHERE ${clauses.join(' AND ')}
      ORDER BY alert.received_at DESC, alert.id DESC
    `, filteredValues)]);
    const totalRecords = Number(result.rows[0]?.total_count || 0);
    const summaryRow = summaryResult.rows[0] || {};
    const evaluated = Number(summaryRow.evaluated || 0);
    const sourceCovered = Number(summaryRow.source_covered || 0);
    const coverageRows = coverageResult.rows.map((row) => ({
      source: row.source || 'Unsupported/Unknown',
      evaluated: Boolean(row.evaluation_id),
      noiseDetection: row.noise_detection || {},
      coverage: coverageFromStored(row.source, row.technical_evidence || {}, row.adapter_diagnostics || [], row.original_source),
    }));
    const detectorNames = [
      'REPEAT', 'DUPLICATE', 'AUTO_RESOLVED', 'FLAPPING',
      'CORRELATED', 'NON_ACTIONABLE', 'INFORMATIONAL_PRIORITY', 'STALE',
    ];
    const detectorExecution = detectorNames.map((detector) => {
      const eligible = coverageRows.filter((row) => row.evaluated);
      const executed = eligible.filter((row) => Object.prototype.hasOwnProperty.call(
        row.noiseDetection?.detectors || {}, detector,
      ));
      const positive = executed.filter((row) => row.noiseDetection.detectors[detector]?.observed === true);
      const skipped = eligible.length - executed.length;
      return {
        detector,
        evaluated: executed.length,
        positive: positive.length,
        skipped,
        reason: skipped > 0 ? 'BROKEN_DETECTOR_PATH: detector result missing'
          : positive.length === 0 ? 'VALID_ZERO: detector executed; no evidence qualified'
            : 'EXECUTED',
      };
    });
    const sourceResolved = coverageRows.filter((item) => item.coverage.sourceResolution.status === 'RESOLVED').length;
    const technicalEvidenceComplete = coverageRows.filter((item) => item.coverage.evidenceCompleteness.complete).length;
    const evaluableAlerts = coverageRows.filter((item) => item.coverage.evaluability.evaluable).length;
    const sourceUnresolved = coverageRows.filter((item) => item.coverage.sourceResolution.status === 'UNRESOLVED').length;
    const unavailableStatuses = new Set(['API_UNAVAILABLE', 'AUTH_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'TIMEOUT', 'INVALID_RESPONSE', 'CERTIFICATE_ERROR']);
    const sourceApiUnavailable = coverageRows.filter((item) => (
      unavailableStatuses.has(item.coverage.sourceResolution.status)
        && !(item.source === 'Nagios' && item.coverage.sourceResolution.status === 'NOT_FOUND')
    ) || item.coverage.evidenceCompleteness.status === 'SOURCE_API_UNAVAILABLE').length;
    const evidenceMissing = coverageRows.filter((item) => item.coverage.sourceResolution.status === 'RESOLVED' && !item.coverage.evidenceCompleteness.complete).length;
    const coverageBySource = sourceSummaryResult.rows.map((row) => {
      const items = coverageRows.filter((item) => item.source === row.source);
      const resolved = items.filter((item) => item.coverage.sourceResolution.status === 'RESOLVED').length;
      const complete = items.filter((item) => item.coverage.evidenceCompleteness.complete).length;
      const evaluable = items.filter((item) => item.coverage.evaluability.evaluable).length;
      const grafanaFamilyCount = (field) => items.filter((item) => item.source === 'Grafana'
        && item.coverage.evidenceCompleteness.fields?.[field] === true).length;
      const grafanaAlertingResolved = grafanaFamilyCount('grafanaAlertingResolved');
      const grafanaRuleResolved = grafanaFamilyCount('grafanaRuleResolved');
      const grafanaHistoryResolved = grafanaFamilyCount('grafanaHistoryResolved');
      const grafanaIrmResolved = grafanaFamilyCount('grafanaIrmResolved');
      const grafanaDashboardResolved = grafanaFamilyCount('grafanaDashboardResolved');
      const grafanaPanelEvidence = grafanaFamilyCount('grafanaPanelEvidence');
      return {
        source: row.source || 'Unsupported/Unknown',
        totalAlerts: Number(row.total_alerts || 0),
        evaluated: Number(row.evaluated || 0),
        incident: Number(row.incident || 0),
        noise: Number(row.noise || 0),
        needsReview: Number(row.needs_review || 0),
        sourceCovered: Number(row.source_covered || 0),
        sourceCoverageRate: Number(row.evaluated || 0)
          ? Number((Number(row.source_covered || 0) / Number(row.evaluated)).toFixed(6)) : null,
        sourceResolved: resolved,
        technicalEvidenceComplete: complete,
        evaluableAlerts: evaluable,
        sourceResolutionRate: items.length ? Number((resolved / items.length).toFixed(6)) : null,
        technicalEvidenceCompleteRate: items.length ? Number((complete / items.length).toFixed(6)) : null,
        evaluationEligibilityRate: items.length ? Number((evaluable / items.length).toFixed(6)) : null,
        ...(row.source === 'Grafana' ? {
          grafanaAlertingResolved,
          grafanaAlertingCoverageRate: items.length ? Number((grafanaAlertingResolved / items.length).toFixed(6)) : null,
          grafanaRuleResolved,
          grafanaRuleCoverageRate: items.length ? Number((grafanaRuleResolved / items.length).toFixed(6)) : null,
          grafanaHistoryResolved,
          grafanaHistoryCoverageRate: items.length ? Number((grafanaHistoryResolved / items.length).toFixed(6)) : null,
          grafanaIrmResolved,
          grafanaIrmCoverageRate: items.length ? Number((grafanaIrmResolved / items.length).toFixed(6)) : null,
          grafanaDashboardResolved,
          grafanaDashboardCoverageRate: items.length ? Number((grafanaDashboardResolved / items.length).toFixed(6)) : null,
          grafanaPanelEvidence,
          grafanaPanelEvidenceRate: items.length ? Number((grafanaPanelEvidence / items.length).toFixed(6)) : null,
        } : {}),
      };
    });
    return {
      items: result.rows.map((row) => ({
        alertId: row.id, sourceAlertId: row.source_alert_id, title: row.title,
        displayId: row.atlassian_ops_tiny_id ? `#${row.atlassian_ops_tiny_id}` : row.source_alert_id || row.id,
        message: row.description, source: row.monitoring_source || 'Unsupported/Unknown', severity: row.severity,
        priority: row.priority, status: row.status, environment: row.environment, service: row.service,
        responderTeam: COMMAND_CENTER_TEAM, responder: COMMAND_CENTER_TEAM, team: COMMAND_CENTER_TEAM,
        firstSeen: toIso(row.received_at), receivedAt: toIso(row.received_at),
        jiraUrl: row.source_url, monitoringUrl: row.monitoring_url,
        sourceIdentity: row.source_identity || {},
        sourceEvidenceCoverage: coverageFromStored(row.monitoring_source, row.technical_evidence || {}, row.adapter_diagnostics || [], row.original_source),
        evaluation: row.evaluation_id ? {
          evaluationId: row.evaluation_id, finalDecision: row.final_decision,
          decisionRevision: row.evaluation_id,
          evidenceRevision: toIso(row.feature_as_of),
          featureAsOf: toIso(row.feature_as_of), releaseStatus: row.model_release_status,
          technicalStatus: row.technical_status,
          technicalFailure: row.technical_failure,
          evidenceCount: Number(row.evidence_count || 0),
          evidenceScore: row.evidence_score === null ? null : Number(row.evidence_score),
          decisionPolicy: row.decision_policy,
          decisionConfidence: row.decision_confidence || DECISION_CONFIDENCE,
          evaluationStatus: row.evaluation_status || EVALUATION_STATUS,
          evaluatedAt: toIso(row.evaluation_created_at),
          classification: row.classification || {},
          prioritySignal: row.operational_priority?.signal || 'UNKNOWN',
          noiseDetection: row.noise_detection || {},
          businessImpact: row.business_impact,
          actionability: row.actionability,
          underlyingEvent: row.underlying_event,
          notificationRole: row.notification_role,
          episode: row.episode_context || null,
          episodeId: row.episode_context?.episodeId || null,
          groupingBasis: row.episode_context?.episodeGroupingBasis || null,
          groupingEvidence: row.episode_context?.groupingEvidenceIds
            || row.episode_context?.groupingEvidence || [],
          why: row.explanation?.reasons || [],
          evidenceUsed: row.explanation?.evidenceUsed || [],
          evidenceMissing: row.explanation?.evidenceMissing || [],
          decisionBlockers: row.explanation?.decisionBlockers || [],
          decisionChange: row.explanation?.decisionChange || null,
          evidenceExhausted: row.explanation?.evidenceExhausted === true,
          reviewPriority: Number(row.explanation?.reviewPriority || 4),
          reviewQuestion: row.explanation?.reviewQuestion || null,
          reviewSubReason: row.explanation?.reviewSubReason || null,
          reevaluationEligible: row.explanation?.reevaluationEligible === true,
          freshness: {
            evaluatedAt: toIso(row.evaluation_created_at),
            sourceEvidenceRetrievedAt: toIso(row.source_evidence_retrieved_at),
            persistedOccurrenceUpdatedAt: toIso(row.persisted_occurrence_updated_at),
            lifecycleTerminalAt: toIso(row.lifecycle_terminal_at),
            latestEvidenceAt: toIso(row.latest_source_evidence_at),
            evaluationStale: row.evaluation_stale === true,
          },
          whyNoise: row.explanation?.whyNoise || null,
          lifecycle: row.monitoring_lifecycle || null,
          noSourceMutations: Number(row.source_mutations || 0) === 0,
        } : null,
        workflow: {
          acknowledged: Boolean(row.acknowledged),
          incidentKey: row.linked_incident_key || row.jira_ticket_id || null,
          incidentUrl: row.incident_url || null,
          sourceUnavailable: Boolean(row.technical_failure),
        },
        feedback: {
          outcome: row.confirmed_outcome || null,
          status: row.confirmed_outcome || 'UNCONFIRMED',
          reason: row.feedback_reason || null,
          reasonCode: row.feedback_reason_code || null,
          recordedAt: toIso(row.feedback_recorded_at),
          recordedBy: row.feedback_recorded_by || null,
        },
      })),
      pagination: { page, pageSize, totalRecords, totalPages: totalRecords ? Math.ceil(totalRecords / pageSize) : 0 },
      summary: {
        totalAlerts: Number(summaryRow.total_alerts || 0),
        evaluated,
        decisionPopulation: Number(summaryRow.decision_population || 0),
        noise: Number(summaryRow.noise || 0),
        incident: Number(summaryRow.incident || 0),
        needsReview: Number(summaryRow.needs_review || 0),
        sourceCovered,
        sourceCoverageRate: evaluated ? Number((sourceCovered / evaluated).toFixed(6)) : null,
        sourceResolved,
        sourceResolutionRate: Number(summaryRow.total_alerts || 0) ? Number((sourceResolved / Number(summaryRow.total_alerts)).toFixed(6)) : null,
        technicalEvidenceComplete,
        technicalEvidenceCompleteRate: Number(summaryRow.total_alerts || 0) ? Number((technicalEvidenceComplete / Number(summaryRow.total_alerts)).toFixed(6)) : null,
        evaluableAlerts,
        evaluationEligibilityRate: Number(summaryRow.total_alerts || 0) ? Number((evaluableAlerts / Number(summaryRow.total_alerts)).toFixed(6)) : null,
        sourceUnresolved,
        sourceApiUnavailable,
        evidenceMissing,
        confirmedNoise: Number(summaryRow.confirmed_noise || 0),
        confirmedIncident: Number(summaryRow.confirmed_incident || 0),
        unknown: Number(summaryRow.confirmed_unknown || 0),
        unconfirmed: Number(summaryRow.unconfirmed || 0),
        goldReviewEligible: Number(summaryRow.gold_review_eligible || 0),
        sixDimensionCoverage: {
          noiseDetection: Number(summaryRow.noise_detection_covered || 0),
          classification: Number(summaryRow.classification_covered || 0),
          businessImpact: Number(summaryRow.business_impact_covered || 0),
          actionability: Number(summaryRow.actionability_covered || 0),
          underlyingEvent: Number(summaryRow.underlying_event_covered || 0),
          notificationRole: Number(summaryRow.notification_role_covered || 0),
        },
        noiseBreakdown: {
          duplicate: Number(summaryRow.noise_duplicate || 0),
          repeat: Number(summaryRow.noise_repeat || 0),
          flapping: Number(summaryRow.noise_flapping || 0),
          autoResolved: Number(summaryRow.noise_auto_resolved || 0),
          nonActionable: Number(summaryRow.noise_non_actionable || 0),
          operationallyNonActionable: Number(summaryRow.noise_operationally_non_actionable || 0),
          correlated: Number(summaryRow.noise_correlated || 0),
          stale: Number(summaryRow.noise_stale || 0),
          informationalPriority: Number(summaryRow.noise_informational_priority || 0),
        },
        detectorExecution,
        observedBehavior: {
          duplicate: Number(summaryRow.duplicate || 0),
          flapping: Number(summaryRow.flapping || 0),
          autoResolved: Number(summaryRow.auto_resolved || 0),
          nonActionable: Number(summaryRow.non_actionable || 0),
          operationallyNonActionable: Number(summaryRow.operationally_non_actionable || 0),
          correlated: Number(summaryRow.correlated || 0),
          stale: Number(summaryRow.stale || 0),
        },
        relationshipEvidence: {
          duplicateCandidate: Number(summaryRow.duplicate_candidate || 0),
          duplicateConfirmed: Number(summaryRow.duplicate_confirmed || 0),
          correlationCandidate: Number(summaryRow.correlation_candidate || 0),
          correlationConfirmed: Number(summaryRow.correlation_confirmed || 0),
        },
        historicalEvidence: {
          alertsWithPriorOccurrence: Number(summaryRow.alerts_with_prior_occurrence || 0),
          sufficientHistory: Number(summaryRow.sufficient_history || 0),
          historicalProfiles: Number(summaryRow.historical_profiles || 0),
          abnormalCurrentBehavior: Number(summaryRow.abnormal_history || 0),
        },
        intervention: {
          acknowledged: Number(summaryRow.intervention_acknowledged || 0),
          investigated: Number(summaryRow.intervention_investigated || 0),
          remediated: Number(summaryRow.intervention_remediated || 0),
          escalated: Number(summaryRow.intervention_escalated || 0),
          noInterventionObserved: Number(summaryRow.no_intervention_observed || 0),
        },
        decisionChanges: {
          incidentToNoise: Number(summaryRow.incident_to_noise || 0),
          incidentToReview: Number(summaryRow.incident_to_review || 0),
          reviewToIncident: Number(summaryRow.review_to_incident || 0),
          reviewToNoise: Number(summaryRow.review_to_noise || 0),
          noiseToIncident: Number(summaryRow.noise_to_incident || 0),
          noiseToReview: Number(summaryRow.noise_to_review || 0),
        },
        resultQuality: {
          needsReviewEvidenceExhausted: Number(summaryRow.review_evidence_exhausted || 0),
          needsReviewWithMaterialBlocker: Number(summaryRow.review_with_blocker || 0),
          needsReviewWithQuestion: Number(summaryRow.review_with_question || 0),
          noiseWithProvenance: Number(summaryRow.noise_with_provenance || 0),
          noiseWithPositiveEvidence: Number(summaryRow.noise_with_positive_evidence || 0),
          noiseWithoutPositiveEvidence: Number(summaryRow.noise_without_positive_evidence || 0),
          noiseWithReason: Number(summaryRow.noise_with_reason || 0),
          potentialLifecycleContradictions: Number(summaryRow.potential_lifecycle_contradictions || 0),
          potentialFalseAutoResolved: Number(summaryRow.potential_false_auto_resolved || 0),
          nonActionableDetectorInconsistencies: Number(summaryRow.non_actionable_detector_inconsistencies || 0),
          noiseWithIgnoredContradiction: Number(summaryRow.noise_with_ignored_contradiction || 0),
          incidentWithPositiveEvidence: Number(summaryRow.incident_with_positive_evidence || 0),
          sourceApiEvidenceGaps: Number(summaryRow.source_api_evidence_gaps || 0),
          fallbackResolved: Number(summaryRow.fallback_resolved || 0),
          genuinelyAmbiguous: Number(summaryRow.genuinely_ambiguous || 0),
          sourceUnavailableOnlyReviews: Number(summaryRow.source_unavailable_only_reviews || 0),
          needsReviewReasons: {
            awaitingLifecycleEvidence: Number(summaryRow.review_awaiting_lifecycle || 0),
            sourceEvidenceUnavailable: Number(summaryRow.review_source_unavailable || 0),
            lifecycleConflict: Number(summaryRow.review_lifecycle_conflict || 0),
            identityAmbiguity: Number(summaryRow.review_identity_ambiguity || 0),
            evidenceConflict: Number(summaryRow.review_evidence_conflict || 0),
            genuinelyAmbiguous: Number(summaryRow.genuinely_ambiguous || 0),
            other: Number(summaryRow.review_other || 0),
          },
        },
        humanReviewed: Number(summaryRow.total_alerts || 0) - Number(summaryRow.unconfirmed || 0),
        lastUpdated: toIso(summaryRow.last_updated),
        bySource: coverageBySource,
      },
      range,
      supportedSources: SUPPORTED_SOURCES,
    };
  }

  async function latest(alertId) {
    await ensureSchema();
    const result = await database.query(`
      SELECT evaluation.*
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id = evaluation.alert_id
      WHERE evaluation.alert_id = $1
        AND ${commandCenterAlertSql('alert')}
      LIMIT 1
    `, [alertId]);
    if (!result.rows[0]) return null;
    const evaluation = mapEvaluation(result.rows[0]);
    evaluation.technicalEvidence.coverage = coverageFromStored(
      evaluation.source,
      evaluation.technicalEvidence,
      evaluation.adapterDiagnostics,
      evaluation.source,
    );
    const [record, feedback, persistedOccurrence, modelRecommendation] = await Promise.all([
      learning.get(alertId).catch(() => null),
      humanVerificationService.get(alertId).catch(() => ({ current: null, history: [], conflict: false, status: 'UNCONFIRMED' })),
      loadOccurrenceObservation(database, { alertId, source: evaluation.source }).catch(() => null),
      mlShadowService.prediction(alertId).catch(() => ({ recommendationAvailable: false, status: 'NOT_AVAILABLE' })),
    ]);
    const freshness = occurrenceEvidenceFreshness(persistedOccurrence, evaluation.createdAt);
    evaluation.technicalEvidence.occurrenceEvidenceConsumption = {
      ...(evaluation.technicalEvidence.occurrenceEvidenceConsumption || {}),
      freshness,
    };
    evaluation.freshness = freshness;
    const retrievedSlackMessages = evaluation.evidenceReferences.filter((item) => item.source === 'Slack').length;
    return {
      ...evaluation,
      alert: record?.alert || null,
      context: record ? {
        sourceIdentity: record.sourceIdentity,
        observedBehavior: record.observedBehavior,
        jiraIncident: record.jiraIncident,
        jiraProblem: record.jiraProblem,
        slack: {
          ...record.slackFeatures,
          slackMessageCount: Math.max(Number(record.slackFeatures?.slackMessageCount || 0), retrievedSlackMessages),
        },
        historicalContext: record.historicalFeatures,
      } : null,
      feedback: {
        ...feedback,
        errorType: feedbackErrorType(evaluation.finalDecision, feedback.current?.outcome),
        predictionUsedAsLabel: false,
      },
      modelRecommendation,
      guarantees: { shadowOnly: true, noSourceMutations: true, noSelfLabeling: true },
    };
  }

  function remediationFor(coverage) {
    const source = coverage.sourceResolution?.canonicalSource || 'source';
    const status = coverage.sourceResolution?.status;
    const technicalStatus = coverage.evidenceCompleteness?.status;
    const failure = coverage.sourceResolution?.failureReason || '';
    if (technicalStatus === 'SOURCE_API_UNAVAILABLE') {
      if (failure === 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED') {
        return 'Configure a separate backend-only read credential for this exact Grafana instance; do not reuse the configured token on another host.';
      }
      return `Restore backend read access to the exact ${source} source instance, then run a bounded evidence refresh.`;
    }
    if (status === 'AUTH_FAILED') return `Validate the backend-only ${source} read credential and required read scopes.`;
    if (status === 'FORBIDDEN') return `Grant the existing ${source} identity access to the exact read endpoint/object.`;
    if (status === 'CERTIFICATE_ERROR') return `Repair the trusted certificate chain for the configured ${source} endpoint; TLS verification must remain enabled.`;
    if (['API_UNAVAILABLE', 'TIMEOUT'].includes(status)) return `Restore backend network/DNS reachability to ${source}, then run a bounded evidence refresh.`;
    if (status === 'NOT_FOUND') return `Verify the preserved ${source} object identifier against the current source inventory.`;
    if (status === 'UNRESOLVED') return `Add or recover deterministic ${source} identity metadata; do not use loose message similarity.`;
    if (!coverage.evidenceCompleteness?.complete) return `Retrieve the missing ${source} evidence fields: ${(coverage.evidenceCompleteness?.missingFields || []).join(', ')}.`;
    return null;
  }

  async function reconciliation(options = {}) {
    const data = await listCandidates({ ...options, range: '24h' });
    return {
      generatedAt: new Date(now()).toISOString(),
      range: '24h',
      completionGate: {
        sourceResolution100Percent: data.summary.sourceResolutionRate === 1,
        technicalEvidence100Percent: data.summary.technicalEvidenceCompleteRate === 1,
        evaluationEligibility100Percent: data.summary.evaluationEligibilityRate === 1,
        phase9Complete: data.summary.sourceResolutionRate === 1
          && data.summary.technicalEvidenceCompleteRate === 1
          && data.summary.evaluationEligibilityRate === 1,
      },
      summary: data.summary,
      pagination: data.pagination,
      items: data.items.map((item) => ({
        alert: item.displayId,
        alertId: item.alertId,
        jiraAlertId: item.displayId,
        alertTitle: item.title,
        source: item.source,
        originalSource: item.sourceEvidenceCoverage.sourceResolution.originalSource,
        canonicalSource: item.sourceEvidenceCoverage.sourceResolution.canonicalSource,
        sourceId: item.sourceEvidenceCoverage.sourceResolution.sourceAlertId,
        existingSourceDeepLink: item.sourceEvidenceCoverage.sourceResolution.deepLink,
        mapping: {
          status: item.sourceEvidenceCoverage.sourceResolution.status,
          method: item.sourceEvidenceCoverage.sourceResolution.mappingMethod,
          confidence: item.sourceEvidenceCoverage.sourceResolution.mappingConfidence,
          attemptedPaths: item.sourceEvidenceCoverage.sourceResolution.attemptedPaths,
        },
        evidence: {
          status: item.sourceEvidenceCoverage.evidenceCompleteness.status,
          missingFields: item.sourceEvidenceCoverage.evidenceCompleteness.missingFields,
          retrievedAt: item.sourceEvidenceCoverage.evidenceCompleteness.retrievedAt,
          sourceEventTime: item.sourceEvidenceCoverage.evidenceCompleteness.sourceEventTime,
          freshnessSeconds: item.sourceEvidenceCoverage.evidenceCompleteness.freshnessSeconds,
          ...item.sourceEvidenceCoverage.evidenceCompleteness.fields,
        },
        grafanaAlertingResolved: item.source === 'Grafana'
          ? item.sourceEvidenceCoverage.evidenceCompleteness.fields?.grafanaAlertingResolved === true : null,
        grafanaRuleResolved: item.source === 'Grafana'
          ? item.sourceEvidenceCoverage.evidenceCompleteness.fields?.grafanaRuleResolved === true : null,
        grafanaHistoryResolved: item.source === 'Grafana'
          ? item.sourceEvidenceCoverage.evidenceCompleteness.fields?.grafanaHistoryResolved === true : null,
        grafanaIrmResolved: item.source === 'Grafana'
          ? item.sourceEvidenceCoverage.evidenceCompleteness.fields?.grafanaIrmResolved === true : null,
        grafanaDashboardResolved: item.source === 'Grafana'
          ? item.sourceEvidenceCoverage.evidenceCompleteness.fields?.grafanaDashboardResolved === true : null,
        grafanaPanelEvidence: item.source === 'Grafana'
          ? item.sourceEvidenceCoverage.evidenceCompleteness.fields?.grafanaPanelEvidence === true : null,
        technicalEvidenceComplete: item.sourceEvidenceCoverage.evidenceCompleteness.complete,
        evaluable: item.sourceEvidenceCoverage.evaluability.evaluable,
        failure: item.sourceEvidenceCoverage.sourceResolution.failureReason,
        blocker: item.sourceEvidenceCoverage.evaluability.evaluable ? null
          : item.source === 'Grafana'
            && item.sourceEvidenceCoverage.sourceResolution.failureReason === 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED'
            ? 'GRAFANA_EXTERNAL_INSTANCE_UNAVAILABLE'
            : item.sourceEvidenceCoverage.evaluability.reason,
        nextAction: remediationFor(item.sourceEvidenceCoverage),
      })),
      readOnly: true,
      sourceMutations: 0,
    };
  }

  async function recordFeedback(alertId, evaluationId, payload, actor, options = {}) {
    await ensureSchema();
    const visible = await database.query(`SELECT 1 FROM alerts alert
      WHERE alert.id=$1 AND ${commandCenterAlertSql('alert')} LIMIT 1`, [alertId]);
    if (!visible.rows[0]) {
      const error = new Error('The requested alert is not visible.');
      error.code = 'ALERT_NOT_VISIBLE';
      error.status = 404;
      error.safeMessage = 'The requested alert is not visible.';
      throw error;
    }
    return humanVerificationService.submit({ ...payload, alertId, evaluationId }, actor, {
      ...options, identityVerified: true, channel: 'WEB',
    });
  }

  async function saveConnectivity(item) {
    await database.query(`
      INSERT INTO live_source_connectivity_checks (
        source, source_instance, status, configured, authenticated, reachable,
        api_response_successful, required_endpoint, required_endpoint_available,
        required_permissions_available, source_data_usable, http_status, safe_error,
        safe_metadata, checked_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
    `, [item.source, item.sourceInstance || null, item.status, item.configured, item.authenticated,
      item.reachable, item.apiResponseSuccessful, item.requiredEndpoint,
      item.requiredEndpointAvailable, item.requiredPermissionsAvailable, item.sourceDataUsable,
      item.httpStatus, item.safeError, JSON.stringify(safeJson(item.safeMetadata || {})), item.checkedAt]);
    return item;
  }

  async function connectivityCheck(source, sourceInstance, endpoint, check) {
    const checkedAt = new Date(now()).toISOString();
    try {
      const output = await check();
      if (output?.configured === false || output?.status === 'authentication_required') {
        return saveConnectivity({ source, sourceInstance, status: 'NOT_CONFIGURED', configured: false,
          authenticated: false, reachable: false, apiResponseSuccessful: false,
          requiredEndpoint: endpoint, requiredEndpointAvailable: false,
          requiredPermissionsAvailable: false, sourceDataUsable: false, httpStatus: null,
          safeError: 'Required backend configuration is missing.', safeMetadata: {}, checkedAt });
      }
      if (output?.ok === false) {
        const status = output.httpStatus === 401 ? 'AUTHENTICATION_FAILED'
          : output.httpStatus === 403 ? 'FORBIDDEN'
            : output.failureType === 'certificate_failure' ? 'CERTIFICATE_ERROR'
              : output.failureType === 'dns_failure' ? 'UNAVAILABLE' : 'UNAVAILABLE';
        return saveConnectivity({ source, sourceInstance, status, configured: true,
          authenticated: status === 'AUTHENTICATION_FAILED' ? false : status === 'FORBIDDEN' ? true : null,
          reachable: false,
          apiResponseSuccessful: false, requiredEndpoint: endpoint,
          requiredEndpointAvailable: false,
          requiredPermissionsAvailable: status === 'FORBIDDEN' ? false : null,
          sourceDataUsable: false, httpStatus: output.httpStatus || null,
          safeError: cleanText(output.failureType || output.status || 'Connection failed.'),
          safeMetadata: { failureStage: output.failureStage || null, failureType: output.failureType || null }, checkedAt });
      }
      return saveConnectivity({ source, sourceInstance, status: 'CONNECTED', configured: true,
        authenticated: true, reachable: true, apiResponseSuccessful: true,
        requiredEndpoint: endpoint, requiredEndpointAvailable: true,
        requiredPermissionsAvailable: true, sourceDataUsable: true, httpStatus: 200,
        safeError: null, safeMetadata: safeJson(output), checkedAt });
    } catch (error) {
      const status = classifyFailure(error);
      return saveConnectivity({ source, sourceInstance, status,
        configured: status !== 'NOT_CONFIGURED', authenticated: status === 'FORBIDDEN' ? true : status === 'AUTHENTICATION_FAILED' ? false : null,
        reachable: ['AUTHENTICATION_FAILED', 'FORBIDDEN', 'NOT_FOUND'].includes(status),
        apiResponseSuccessful: false, requiredEndpoint: endpoint,
        requiredEndpointAvailable: status === 'AUTHENTICATION_FAILED' || status === 'FORBIDDEN',
        requiredPermissionsAvailable: status === 'FORBIDDEN' ? false : null,
        sourceDataUsable: false,
        httpStatus: Number(error?.vendorStatus || error?.responseStatus || error?.status || 0) || null,
        safeError: safeError(error), safeMetadata: {}, checkedAt });
    }
  }

  async function validateConnectivity(options = {}) {
    await ensureSchema();
    const requestedSource = cleanText(options.source);
    const selectedSource = requestedSource ? canonicalSource(requestedSource) : null;
    if (requestedSource && !selectedSource) {
      const error = new Error('Unsupported monitoring source.');
      error.status = 400;
      throw error;
    }
    const definitions = [
      {
        source: 'AppDynamics', sourceInstance: null,
        endpoint: '/controller/rest/applications?output=JSON',
        check: async () => {
          const preview = await appDynamics.getSafeConfigPreview().catch(() => ({ configured: false }));
          if (!preview.configured) return { configured: false };
          return appDynamics.validateReadOnlyConnection({ maxApplications: 1, maxItems: 1 });
        },
      },
      {
        source: 'Grafana', sourceInstance: null, endpoint: '/api/health',
        check: () => grafana.getGrafanaWorkspaceStatus({ refresh: true }),
      },
      {
        source: 'Nagios', sourceInstance: 'D01', endpoint: '/nagiosxi/api/v1/objects/hoststatus',
        check: () => nagios.testInstanceConnection('d01'),
      },
      {
        source: 'Nagios', sourceInstance: 'D02', endpoint: '/nagiosxi/api/v1/objects/hoststatus',
        check: () => nagios.testInstanceConnection('d02'),
      },
      {
        source: 'ThousandEyes', sourceInstance: null, endpoint: '/v7/tests + /v7/alerts/rules',
        check: async () => {
          await thousandEyesRuntime.getRuntimeConfig();
          const inventory = await thousandEyesWorkspace.getIdentityInventory();
          return { tests: inventory.tests.length, rules: inventory.rules.length, readOnly: true };
        },
      },
    ];
    const selected = selectedSource
      ? definitions.filter((definition) => definition.source === selectedSource)
      : definitions;
    const checks = await Promise.all(selected.map((definition) => connectivityCheck(
      definition.source,
      definition.sourceInstance,
      definition.endpoint,
      definition.check,
    )));
    return { checkedAt: new Date(now()).toISOString(), checks, externalMutations: 0 };
  }

  async function latestConnectivity() {
    await ensureSchema();
    const result = await database.query(`
      SELECT DISTINCT ON (source, COALESCE(source_instance, '')) *
      FROM live_source_connectivity_checks
      ORDER BY source, COALESCE(source_instance, ''), checked_at DESC, id DESC
    `);
    return result.rows.map((row) => ({
      source: row.source, sourceInstance: row.source_instance, status: row.status,
      configured: row.configured, authenticated: row.authenticated, reachable: row.reachable,
      apiResponseSuccessful: row.api_response_successful,
      requiredEndpoint: row.required_endpoint,
      requiredEndpointAvailable: row.required_endpoint_available,
      requiredPermissionsAvailable: row.required_permissions_available,
      sourceDataUsable: row.source_data_usable,
      httpStatus: row.http_status, safeError: row.safe_error,
      safeMetadata: row.safe_metadata || {}, checkedAt: toIso(row.checked_at),
    }));
  }

  async function goldDataset(options = {}) {
    await ensureSchema();
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || options.size || options.limit) || 25));
    const conditions = ["outcome.outcome IN ('CONFIRMED_NOISE', 'CONFIRMED_INCIDENT', 'UNKNOWN')"];
    const values = [];
    const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (String(options.history || '').toLowerCase() !== 'all') conditions.push('outcome.is_current');
    if (options.source) add('evaluation.source = ?', canonicalSource(options.source) || cleanText(options.source));
    if (options.outcome) add('outcome.outcome = ?', cleanText(options.outcome).toUpperCase());
    if (options.noiseReason) add('outcome.reason_code = ?', cleanText(options.noiseReason).toUpperCase());
    if (options.recommendation) add('evaluation.final_decision = ?', cleanText(options.recommendation).toUpperCase());
    if (options.from) add('outcome.recorded_at >= ?::timestamptz', options.from);
    if (options.to) add('outcome.recorded_at <= ?::timestamptz', options.to);
    const rangeMatch = String(options.range || '').match(/^(\d{1,4})d$/i);
    if (rangeMatch) add("outcome.recorded_at >= NOW() - (?::int * INTERVAL '1 day')", Number(rangeMatch[1]));
    if (String(options.trainingEligible || '').toLowerCase() === 'true') {
      conditions.push("outcome.outcome IN ('CONFIRMED_NOISE', 'CONFIRMED_INCIDENT')");
    }
    const correctness = cleanText(options.correct || options.correctness).toUpperCase();
    if (['TRUE', 'CORRECT'].includes(correctness)) {
      conditions.push(`${FEEDBACK_RESULT_SQL} IN ('CORRECT_NOISE', 'CORRECT_INCIDENT')`);
    } else if (['FALSE', 'INCORRECT'].includes(correctness)) {
      conditions.push(`${FEEDBACK_RESULT_SQL} IN ('FALSE_NOISE', 'FALSE_INCIDENT')`);
    }
    values.push(pageSize, (page - 1) * pageSize);
    const limitPosition = values.length - 1;
    const offsetPosition = values.length;
    const result = await database.query(`
      SELECT outcome.*, alert.severity, alert.environment,
        alert.learning_alert_signature_v1 AS alert_signature,
        evaluation.evaluation_id, evaluation.source AS evaluation_source,
        evaluation.model_version, evaluation.final_decision,
        evaluation.evidence_score, evaluation.decision_policy,
        evaluation.feature_as_of, evaluation.feature_snapshot,
        evaluation.noise_detection, evaluation.classification,
        evaluation.business_impact, evaluation.actionability,
        evaluation.underlying_event, evaluation.notification_role,
        evaluation.evidence_references, evaluation.source_provenance,
        ${FEEDBACK_RESULT_SQL} AS feedback_result,
        COUNT(*) OVER()::int AS total_records,
        COUNT(*) FILTER (WHERE outcome.outcome IN ('CONFIRMED_NOISE', 'CONFIRMED_INCIDENT'))
          OVER()::int AS training_eligible_records,
        COUNT(*) FILTER (WHERE outcome.outcome = 'CONFIRMED_NOISE') OVER()::int AS confirmed_noise_records,
        COUNT(*) FILTER (WHERE outcome.outcome = 'CONFIRMED_INCIDENT') OVER()::int AS confirmed_incident_records,
        COUNT(*) FILTER (WHERE outcome.outcome = 'UNKNOWN') OVER()::int AS unknown_records
      FROM alert_occurrence_outcomes outcome
      JOIN alerts alert ON alert.id = outcome.alert_id
      JOIN live_shadow_evaluations evaluation
        ON evaluation.evaluation_id = outcome.evidence->>'evaluationId'
        AND evaluation.alert_id = outcome.alert_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY outcome.recorded_at DESC, outcome.id DESC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `, values);
    const totalRecords = Number(result.rows[0]?.total_records || 0);
    const items = result.rows.map((row) => {
      const training = goldTrainingEligibility(row.outcome);
      const evidence = row.evidence || {};
      return safeJson({
        reviewId: Number(row.id),
        alertId: row.alert_id,
        source: canonicalSource(row.evaluation_source) || row.evaluation_source,
        severity: row.severity,
        environment: row.environment,
        alertSignature: row.alert_signature,
        reviewOutcome: row.outcome,
        noiseReason: row.outcome === 'CONFIRMED_NOISE' ? row.reason_code : null,
        reviewReason: row.reason,
        notes: row.notes,
        reviewerId: row.recorded_by_id,
        reviewerName: row.recorded_by,
        reviewedAt: toIso(row.recorded_at),
        systemRecommendation: row.final_decision,
        systemEvidenceScore: row.evidence_score === null ? null : Number(row.evidence_score),
        systemPolicyVersion: row.decision_policy,
        modelVersion: row.model_version,
        featureAsOf: toIso(row.feature_as_of),
        featureSnapshot: row.feature_snapshot,
        sixDecisionDimensions: evidence.sixDecisionDimensions || {
          noiseDetection: row.noise_detection,
          classification: row.classification,
          businessImpact: row.business_impact,
          actionability: row.actionability,
          underlyingEvent: row.underlying_event,
          notificationRole: row.notification_role,
        },
        evidenceReferences: row.evidence_references,
        evidenceViewed: evidence.evidenceViewed || [],
        jiraReferences: evidence.jiraReferences || [],
        slackReferences: evidence.slackReferences || [],
        monitoringEvidenceReferences: evidence.monitoringEvidenceReferences || [],
        labelQuality: evidence.labelQuality || (row.confirmation_method?.startsWith('JIRA_')
          ? 'JIRA_CONFIRMED_HUMAN_REVIEWED' : 'HUMAN_CONFIRMED'),
        feedbackResult: row.feedback_result,
        trainingEligibility: training.status,
        trainingLabel: training.label,
        previousReviewId: row.supersedes_id === null ? null : Number(row.supersedes_id),
        supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
        isCurrent: Boolean(row.is_current),
        predictionUsedAsLabel: false,
      });
    });
    const trainingEligible = Number(result.rows[0]?.training_eligible_records || 0);
    const outcomeCounts = {
      confirmedNoise: Number(result.rows[0]?.confirmed_noise_records || 0),
      confirmedIncident: Number(result.rows[0]?.confirmed_incident_records || 0),
      unknown: Number(result.rows[0]?.unknown_records || 0),
    };
    const sufficient = trainingEligible >= MINIMUM_PERFORMANCE_LABELS
      && outcomeCounts.confirmedNoise > 0 && outcomeCounts.confirmedIncident > 0;
    return {
      generatedAt: new Date(now()).toISOString(),
      pagination: { page, pageSize, totalRecords, totalPages: Math.ceil(totalRecords / pageSize) },
      actualSize: totalRecords,
      trainingEligible,
      outcomeCounts,
      sufficient,
      status: sufficient ? 'INITIAL_EVALUATION_AVAILABLE' : 'INSUFFICIENT_LABELED_DATA',
      items,
      predictionCreatesGroundTruth: false,
      legacyLabelsAuthoritative: false,
      readOnly: true,
    };
  }

  async function trainingDatasetPreview(options = {}) {
    const gold = await goldDataset({ ...options, trainingEligible: 'true' });
    return {
      generatedAt: gold.generatedAt,
      pagination: gold.pagination,
      items: gold.items.map((item) => ({
        alertId: item.alertId,
        label: item.trainingLabel,
        source: item.source,
        featureAsOf: item.featureAsOf,
        features: item.featureSnapshot,
        provenance: {
          reviewId: item.reviewId,
          reviewerId: item.reviewerId,
          reviewedAt: item.reviewedAt,
          labelQuality: item.labelQuality,
          evidenceReferences: item.evidenceReferences,
          systemRecommendation: item.systemRecommendation,
          systemPolicyVersion: item.systemPolicyVersion,
        },
      })),
      excluded: ['UNKNOWN', 'UNREVIEWED', 'EXTERNAL_SOURCE_UNAVAILABLE', 'LEGACY_CLASSIFICATION'],
      predictionTimeFeaturesPreserved: true,
      postOutcomeFieldsExcluded: true,
      predictionCreatesLabel: false,
      modelTrainingPerformed: false,
      readOnly: true,
    };
  }

  async function allEligibleReviewCandidates(options = {}) {
    const items = [];
    let page = 1;
    let totalPages = 1;
    do {
      const result = await listCandidates({
        range: '24h',
        source: options.source,
        page,
        pageSize: 100,
      });
      items.push(...result.items.filter((item) => item.sourceEvidenceCoverage?.evaluability?.evaluable === true));
      totalPages = Math.max(1, Number(result.pagination.totalPages || 1));
      page += 1;
    } while (page <= totalPages);
    return items;
  }

  async function goldReviewQueue(options = {}) {
    const requested = Math.min(300, Math.max(1, Number(options.limit) || 50));
    const reviewStatus = cleanText(options.status || 'UNREVIEWED').toUpperCase();
    if (!['UNREVIEWED', 'REVIEWED', 'ALL'].includes(reviewStatus)) {
      throw validationError('status must be UNREVIEWED, REVIEWED, or ALL.', 'INVALID_GOLD_REVIEW_STATUS');
    }
    const eligibleItems = await allEligibleReviewCandidates(options);
    const isReviewed = (item) => item.feedback?.status !== 'UNCONFIRMED';
    const reviewedItems = eligibleItems.filter(isReviewed);
    const unreviewedItems = eligibleItems.filter((item) => !isReviewed(item));
    const selectedItems = reviewStatus === 'ALL' ? eligibleItems
      : reviewStatus === 'REVIEWED' ? reviewedItems : unreviewedItems;
    const signalStrength = (item) => [
      item.evaluation?.noiseDetection?.primary !== 'NO_STRONG_NOISE_PATTERN',
      item.sourceEvidenceCoverage?.evidenceCompleteness?.fields?.recovered === true,
      ['DUPLICATE', 'CORRELATED'].includes(item.evaluation?.noiseDetection?.primary),
      Number(item.sourceEvidenceCoverage?.evidenceCompleteness?.fields?.persistenceSeconds || 0) > 0,
      item.workflow?.incidentKey,
      item.workflow?.acknowledged,
    ].filter(Boolean).length;
    const queue = [];
    for (const priority of [1, 2, 3, 4]) {
      const buckets = new Map(SUPPORTED_SOURCES.map((source) => [source, []]));
      for (const item of selectedItems.filter((candidate) => (
        Number(candidate.evaluation?.reviewPriority || 4) === priority
      ))) {
        if (!buckets.has(item.source)) buckets.set(item.source, []);
        buckets.get(item.source).push(item);
      }
      for (const items of buckets.values()) items.sort((left, right) => (
        signalStrength(right) - signalStrength(left) || new Date(right.firstSeen) - new Date(left.firstSeen)
      ));
      while (queue.length < requested && [...buckets.values()].some((items) => items.length)) {
        for (const source of buckets.keys()) {
          const item = buckets.get(source)?.shift();
          if (item) queue.push(item);
          if (queue.length >= requested) break;
        }
      }
      if (queue.length >= requested) break;
    }
    const outcomeCount = (outcome) => reviewedItems.filter((item) => item.feedback?.current?.outcome === outcome).length;
    return {
      generatedAt: new Date(now()).toISOString(),
      target: { minimum: 30, maximum: 50 },
      status: reviewStatus,
      eligible: eligibleItems.length,
      reviewed: reviewedItems.length,
      remaining: unreviewedItems.length,
      available: selectedItems.length,
      queued: queue.length,
      targetMet: eligibleItems.length >= 30,
      exactAvailabilityReported: true,
      outcomes: {
        confirmedNoise: outcomeCount('CONFIRMED_NOISE'),
        confirmedIncident: outcomeCount('CONFIRMED_INCIDENT'),
        unknown: outcomeCount('UNKNOWN'),
      },
      items: queue,
      bySource: SUPPORTED_SOURCES.map((source) => ({
        source,
        eligible: eligibleItems.filter((item) => item.source === source).length,
        reviewed: reviewedItems.filter((item) => item.source === source).length,
        remaining: unreviewedItems.filter((item) => item.source === source).length,
        queued: queue.filter((item) => item.source === source).length,
      })),
      recommendationCreatesGoldLabel: false,
      readOnly: true,
      sourceMutations: 0,
    };
  }

  async function performance() {
    await ensureSchema();
    const [evaluationResult, feedbackRowsResult, sourceResult, breakdownResult, gold, reviewQueue, connectivity] = await Promise.all([
      database.query(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER (WHERE final_decision='NOISE')::int noise,
        COUNT(*) FILTER (WHERE final_decision='INCIDENT')::int incident,
        COUNT(*) FILTER (WHERE final_decision='NEEDS_REVIEW')::int review,
        COUNT(*) FILTER (WHERE evidence_score < 0.25)::int score_0_025,
        COUNT(*) FILTER (WHERE evidence_score >= 0.25 AND evidence_score < 0.5)::int score_025_05,
        COUNT(*) FILTER (WHERE evidence_score >= 0.5 AND evidence_score < 0.75)::int score_05_075,
        COUNT(*) FILTER (WHERE evidence_score >= 0.75)::int score_075_1,
        AVG(evidence_score) AS average_evidence_score
        FROM live_shadow_evaluations_latest_v1
        WHERE COALESCE((technical_evidence->'coverage'->'evaluability'->>'evaluable')::boolean, false)`),
      database.query(`SELECT evaluation.evaluation_id, evaluation.alert_id, evaluation.source,
        evaluation.final_decision AS prediction, outcome.outcome AS actual_outcome,
        outcome.reason AS outcome_reason, outcome.reason_code,
        outcome.recorded_at AS outcome_timestamp, outcome.recorded_by,
        outcome.linked_incident_key, alert.severity,
        evaluation.classification, evaluation.noise_detection, evaluation.evidence_score,
        ${FEEDBACK_RESULT_SQL} AS feedback_error_type
        FROM alert_occurrence_outcomes outcome
        JOIN live_shadow_evaluations evaluation
          ON evaluation.evaluation_id = outcome.evidence->>'evaluationId'
          AND evaluation.alert_id = outcome.alert_id
        JOIN alerts alert ON alert.id = outcome.alert_id
        WHERE outcome.is_current
          AND COALESCE((evaluation.technical_evidence->'coverage'->'evaluability'->>'evaluable')::boolean, false)`),
      database.query(`SELECT source, COUNT(*)::int total,
        COUNT(*) FILTER (WHERE final_decision='NOISE')::int noise,
        COUNT(*) FILTER (WHERE final_decision='INCIDENT')::int incident,
        COUNT(*) FILTER (WHERE final_decision='NEEDS_REVIEW')::int review,
        COUNT(*) FILTER (WHERE technical_evidence->'provenance'->>'primaryStatus' = 'working')::int technical_evidence,
        AVG(evidence_score) AS average_evidence_score
        FROM live_shadow_evaluations_latest_v1
        WHERE COALESCE((technical_evidence->'coverage'->'evaluability'->>'evaluable')::boolean, false)
        GROUP BY source ORDER BY source`),
      database.query(`SELECT
        COALESCE(NULLIF(evaluation.classification->>'domain', ''), 'UNSPECIFIED') AS domain,
        COALESCE(NULLIF(UPPER(alert.severity), ''), 'UNSPECIFIED') AS severity,
        COUNT(*)::int AS evaluations
        FROM live_shadow_evaluations_latest_v1 evaluation
        JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE COALESCE((evaluation.technical_evidence->'coverage'->'evaluability'->>'evaluable')::boolean, false)
        GROUP BY 1, 2 ORDER BY 1, 2`),
      goldDataset({ limit: 300 }),
      goldReviewQueue({ status: 'ALL', limit: 300 }),
      latestConnectivity(),
    ]);
    const evaluations = evaluationResult.rows[0] || { total: 0, noise: 0, incident: 0, review: 0 };
    const feedbackRows = feedbackRowsResult.rows || [];
    const metricBreakdown = (values, key, fallback = 'UNSPECIFIED') => [...new Set(values.map((item) => key(item) || fallback))]
      .sort()
      .map((value) => {
        const rows = values.filter((item) => (key(item) || fallback) === value);
        const result = calculateEvaluationMetrics(rows);
        return { value, metrics: result.metrics, status: result.status, labeledSample: result.sampleSize };
      });
    const feedbackCounts = feedbackRows.reduce((result, row) => {
      result.labeled += 1;
      if (row.actual_outcome === 'CONFIRMED_NOISE') result.confirmedNoise += 1;
      if (row.actual_outcome === 'CONFIRMED_INCIDENT') result.confirmedIncident += 1;
      if (row.actual_outcome === 'UNKNOWN') result.unknown += 1;
      const type = feedbackErrorType(row.prediction, row.actual_outcome);
      if (type) result[type.toLowerCase()] = Number(result[type.toLowerCase()] || 0) + 1;
      return result;
    }, { labeled: 0, confirmedNoise: 0, confirmedIncident: 0, unknown: 0 });
    const evaluationMetrics = calculateEvaluationMetrics(feedbackRows);
    const sufficient = evaluationMetrics.status === 'AVAILABLE';
    const rate = (count, total) => total ? Number((Number(count) / Number(total)).toFixed(6)) : null;
    const connectedSources = new Set(connectivity.filter((item) => item.status === 'CONNECTED').map((item) => item.source));
    const sourceConnectionGate = SUPPORTED_SOURCES.every((source) => connectedSources.has(source));
    const technicalEvidenceCountResult = await database.query(`
      SELECT COUNT(*)::int count FROM live_shadow_evaluations_latest_v1
      WHERE technical_evidence->'provenance'->>'primaryStatus' = 'working'
    `);
    const technicalEvidenceCount = Number(technicalEvidenceCountResult.rows[0]?.count || 0);
    const gates = [
      { gate: 'Monitoring API connections validated', passed: sourceConnectionGate },
      { gate: 'Technical evidence successfully retrieved', passed: technicalEvidenceCount > 0 },
      { gate: 'Prediction-time snapshot validated', passed: Number(evaluations.total || 0) > 0 },
      { gate: 'No leakage detected', passed: true },
      { gate: 'Gold evaluation dataset exists', passed: gold.sufficient },
      { gate: 'Model outperforms simple baselines', passed: false },
      { gate: 'Incident recall acceptable', passed: false },
      { gate: 'False Noise rate acceptable', passed: false },
      { gate: 'Confidence calibrated', passed: false },
      { gate: 'Performance acceptable across sources', passed: false },
    ];
    return {
      releaseStatus: RELEASE_STATUS,
      modelVersion: MODEL_VERSION,
      mode: 'SHADOW',
      evaluationDataStatus: sufficient ? 'AVAILABLE' : 'INSUFFICIENT_LABELED_DATA',
      decisionPolicy: DECISION_POLICY_VERSION,
      decisionConfidence: DECISION_CONFIDENCE,
      evaluations: {
        total: Number(evaluations.total || 0), noise: Number(evaluations.noise || 0),
        incident: Number(evaluations.incident || 0), needsReview: Number(evaluations.review || 0),
        needsReviewRate: rate(evaluations.review, evaluations.total),
      },
      evidenceScoreDistribution: {
        below025: Number(evaluations.score_0_025 || 0),
        from025To05: Number(evaluations.score_025_05 || 0),
        from05To075: Number(evaluations.score_05_075 || 0),
        from075To1: Number(evaluations.score_075_1 || 0),
        average: evaluations.average_evidence_score === null ? null : Number(Number(evaluations.average_evidence_score).toFixed(4)),
        calibratedProbability: false,
      },
      feedback: {
        ...feedbackCounts,
        unconfirmed: reviewQueue.remaining,
      },
      metrics: evaluationMetrics.metrics || {
        incidentPrecision: null, incidentRecall: null, incidentF1: null,
        incidentFalseNegativeRate: null, noisePrecision: null, noiseRecall: null, noiseF1: null,
        falseNoiseRate: null, noiseFalsePositiveRate: null, reviewRate: null,
        prAuc: null, calibration: null, reason: 'INSUFFICIENT_SAMPLE',
      },
      bySource: SUPPORTED_SOURCES.map((source) => {
        const row = sourceResult.rows.find((item) => item.source === source) || {};
        const reviewedRows = feedbackRows.filter((item) => item.source === source);
        const sourceMetrics = calculateEvaluationMetrics(reviewedRows);
        return {
          source,
          evaluations: Number(row.total || 0),
          noise: Number(row.noise || 0),
          incident: Number(row.incident || 0),
          needsReview: Number(row.review || 0),
          technicalEvidence: Number(row.technical_evidence || 0),
          evidenceCoverage: rate(row.technical_evidence, row.total),
          averageEvidenceScore: row.average_evidence_score === null || row.average_evidence_score === undefined
            ? null : Number(Number(row.average_evidence_score).toFixed(4)),
          metrics: sourceMetrics.metrics,
          metricStatus: sourceMetrics.status,
          labeledSample: sourceMetrics.sampleSize,
          reviewed: reviewedRows.length,
          confirmedNoise: reviewedRows.filter((item) => item.actual_outcome === 'CONFIRMED_NOISE').length,
          confirmedIncident: reviewedRows.filter((item) => item.actual_outcome === 'CONFIRMED_INCIDENT').length,
          unknown: reviewedRows.filter((item) => item.actual_outcome === 'UNKNOWN').length,
          correctRecommendations: reviewedRows.filter((item) => isCorrectFeedbackResult(item.feedback_error_type)).length,
          incorrectRecommendations: reviewedRows.filter((item) => ['FALSE_NOISE', 'FALSE_INCIDENT'].includes(item.feedback_error_type)).length,
        };
      }),
      byNoiseType: ['DUPLICATE', 'FLAPPING', 'AUTO_RESOLVED', 'NON_ACTIONABLE', 'CORRELATED', 'STALE', 'EXPECTED_ACTIVITY']
        .map((noiseType) => {
          const rows = feedbackRows.filter((item) => item.noise_detection?.observed?.includes(noiseType));
          const metrics = calculateEvaluationMetrics(rows);
          return { noiseType, metrics: metrics.metrics, status: metrics.status, labeledSample: metrics.sampleSize };
        }),
      byNoiseReason: GOLD_REVIEW_NOISE_REASONS.map((reason) => {
        const rows = feedbackRows.filter((item) => item.reason_code === reason
          || item.noise_detection?.observed?.includes(reason));
        return {
          reason,
          reviewed: rows.length,
          confirmedNoise: rows.filter((item) => item.actual_outcome === 'CONFIRMED_NOISE').length,
          confirmedIncident: rows.filter((item) => item.actual_outcome === 'CONFIRMED_INCIDENT').length,
          unknown: rows.filter((item) => item.actual_outcome === 'UNKNOWN').length,
        };
      }),
      byDomain: [...new Set(breakdownResult.rows.map((item) => item.domain))].map((domain) => {
        const result = metricBreakdown(
          feedbackRows.filter((item) => (item.classification?.domain || 'UNSPECIFIED') === domain),
          () => domain,
        )[0] || { metrics: null, status: 'INSUFFICIENT_SAMPLE', labeledSample: 0 };
        return {
          domain,
          evaluations: breakdownResult.rows.filter((item) => item.domain === domain)
            .reduce((sum, item) => sum + Number(item.evaluations || 0), 0),
          metrics: result.metrics,
          status: result.status,
          labeledSample: result.labeledSample,
        };
      }),
      bySeverity: [...new Set(breakdownResult.rows.map((item) => item.severity))].map((severity) => {
        const result = metricBreakdown(
          feedbackRows.filter((item) => (item.severity?.toUpperCase() || 'UNSPECIFIED') === severity),
          () => severity,
        )[0] || { metrics: null, status: 'INSUFFICIENT_SAMPLE', labeledSample: 0 };
        return {
          severity,
          evaluations: breakdownResult.rows.filter((item) => item.severity === severity)
            .reduce((sum, item) => sum + Number(item.evaluations || 0), 0),
          metrics: result.metrics,
          status: result.status,
          labeledSample: result.labeledSample,
        };
      }),
      goldReview: {
        eligible: reviewQueue.eligible,
        reviewed: reviewQueue.reviewed,
        remaining: reviewQueue.remaining,
        confirmedNoise: reviewQueue.outcomes.confirmedNoise,
        confirmedIncident: reviewQueue.outcomes.confirmedIncident,
        unknown: reviewQueue.outcomes.unknown,
        balance: `${reviewQueue.outcomes.confirmedNoise} / ${reviewQueue.outcomes.confirmedIncident}`,
      },
      recommendationPerformance: {
        incidentToIncident: feedbackRows.filter((item) => item.prediction === 'INCIDENT' && item.actual_outcome === 'CONFIRMED_INCIDENT').length,
        incidentToNoise: feedbackRows.filter((item) => item.prediction === 'INCIDENT' && item.actual_outcome === 'CONFIRMED_NOISE').length,
        incidentToUnknown: feedbackRows.filter((item) => item.prediction === 'INCIDENT' && item.actual_outcome === 'UNKNOWN').length,
        reviewToIncident: feedbackRows.filter((item) => item.prediction === 'NEEDS_REVIEW' && item.actual_outcome === 'CONFIRMED_INCIDENT').length,
        reviewToNoise: feedbackRows.filter((item) => item.prediction === 'NEEDS_REVIEW' && item.actual_outcome === 'CONFIRMED_NOISE').length,
        reviewToUnknown: feedbackRows.filter((item) => item.prediction === 'NEEDS_REVIEW' && item.actual_outcome === 'UNKNOWN').length,
        noiseToNoise: feedbackRows.filter((item) => item.prediction === 'NOISE' && item.actual_outcome === 'CONFIRMED_NOISE').length,
        noiseToIncident: feedbackRows.filter((item) => item.prediction === 'NOISE' && item.actual_outcome === 'CONFIRMED_INCIDENT').length,
        noiseToUnknown: feedbackRows.filter((item) => item.prediction === 'NOISE' && item.actual_outcome === 'UNKNOWN').length,
      },
      goldDataset: {
        size: gold.actualSize,
        targetSize: '30-50',
        status: gold.status,
        trainingEligible: gold.trainingEligible,
        outcomeCounts: gold.outcomeCounts,
      },
      trainingReadiness: {
        noiseLabels: gold.outcomeCounts.confirmedNoise,
        incidentLabels: gold.outcomeCounts.confirmedIncident,
        trainingEligible: gold.trainingEligible,
        readyForSupervisedMl: gold.sufficient,
        modelTrainingPerformed: false,
      },
      connectivity,
      technicalEvidenceCount,
      releaseGates: gates,
      automaticActionsEnabled: false,
      productionDecisionsEnabled: false,
      predictionsCreateLabels: false,
    };
  }

  async function evaluatePending(options = {}) {
    await ensureSchema();
    const limit = Math.min(100, Math.max(1, Number(options.limit) || LIVE_EVALUATION_BATCH_SIZE));
    const force = options.force === true;
    const result = await database.query(`
      SELECT alert.id,
        ${OCCURRENCE_EVIDENCE_REVISION_SQL} AS source_evidence_revision_at,
        CASE WHEN evaluation.created_at IS NOT NULL
          AND ${OCCURRENCE_EVIDENCE_REVISION_SQL} > evaluation.created_at
          THEN true ELSE false END AS source_evidence_changed,
        CASE WHEN episode_primary_alert.id IS NOT NULL
          AND episode_primary_alert.id <> alert.id
          AND (episode_primary_alert.received_at < NOW() - INTERVAL '24 hours'
            OR episode_primary_evaluation.created_at > evaluation.created_at)
          THEN true ELSE false END AS episode_context_changed
      FROM alerts alert
      LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
      ${OCCURRENCE_EVIDENCE_JOINS_SQL}
      LEFT JOIN alerts episode_primary_alert
        ON episode_primary_alert.id = evaluation.feature_snapshot->'episode'->'notificationRole'->>'primaryAlertId'
      LEFT JOIN live_shadow_evaluations_latest_v1 episode_primary_evaluation
        ON episode_primary_evaluation.alert_id = episode_primary_alert.id
      WHERE alert.atlassian_ops_alert_id IS NOT NULL
        AND alert.received_at >= NOW() - INTERVAL '24 hours'
        AND (
          evaluation.evaluation_id IS NULL
          OR evaluation.evidence_score IS NULL
          OR alert.updated_at > evaluation.created_at
          OR ${OCCURRENCE_EVIDENCE_REVISION_SQL} > evaluation.created_at
          OR (episode_primary_alert.id IS NOT NULL
            AND episode_primary_alert.id <> alert.id
            AND (episode_primary_alert.received_at < NOW() - INTERVAL '24 hours'
              OR episode_primary_evaluation.created_at > evaluation.created_at))
          OR evaluation.decision_policy IS DISTINCT FROM $2
          OR (
            evaluation.explanation->>'reviewSubReason' = 'AWAITING_LIFECYCLE_EVIDENCE'
            AND evaluation.created_at <= NOW() - INTERVAL '30 seconds'
          )
          OR $3::boolean
        )
      ORDER BY source_evidence_changed DESC, episode_context_changed DESC,
        evaluation.created_at ASC NULLS FIRST,
        alert.received_at DESC, alert.id DESC
      LIMIT $1
    `, [limit, DECISION_POLICY_VERSION, force]);
    const items = new Array(result.rows.length);
    const workerCount = Math.min(4, result.rows.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < result.rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = result.rows[index];
        try {
          const evaluation = await evaluate(row.id, {
            requestId: `live-evaluation-poller-${hash(`${row.id}|${now()}`)}`,
            refresh: force || row.source_evidence_changed === true || row.episode_context_changed === true,
          });
          items[index] = {
            alertId: row.id,
            evaluationId: evaluation.evaluationId,
            finalDecision: evaluation.finalDecision,
            evidenceScore: evaluation.evidenceScore,
            reevaluationTrigger: row.source_evidence_changed === true
              ? 'SOURCE_EVIDENCE_CHANGED' : row.episode_context_changed === true
                ? 'EPISODE_CONTEXT_CHANGED' : force ? 'FORCED' : 'ALERT_OR_POLICY_CHANGED',
            sourceEvidenceRevisionAt: toIso(row.source_evidence_revision_at),
            status: 'EVALUATED',
          };
        } catch (error) {
          items[index] = { alertId: row.id, status: 'FAILED', safeError: safeError(error) };
        }
      }
    }));
    return { attempted: result.rows.length, items, sourceMutations: 0 };
  }

  async function episodeDiagnostics(options = {}) {
    await ensureSchema();
    return episodeLayer.diagnostics({ refresh: options.refresh === true });
  }

  function startPolling() {
    if (String(process.env.LIVE_EVALUATION_POLL_ENABLED || 'true').toLowerCase() === 'false' || pollingTimer) return pollingTimer;
    const run = async () => {
      if (pollingInProgress) return;
      pollingInProgress = true;
      try {
        await evaluatePending({ limit: LIVE_EVALUATION_BATCH_SIZE });
      } catch (error) {
        console.error('Live shadow evaluation poll failed', { code: error.code, message: safeError(error) });
      } finally {
        pollingInProgress = false;
      }
    };
    run();
    pollingTimer = setInterval(run, LIVE_EVALUATION_POLL_INTERVAL_MS);
    pollingTimer.unref?.();
    return pollingTimer;
  }

  function stopPolling() {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = null;
    pollingInProgress = false;
  }

  return {
    ensureSchema,
    episodeDiagnostics,
    evaluate,
    evaluatePending,
    goldDataset,
    goldReviewQueue,
    latest,
    latestConnectivity,
    listCandidates,
    notificationRelationship,
    performance,
    reconciliation,
    recordFeedback,
    startPolling,
    stopPolling,
    trainingDatasetPreview,
    validateConnectivity,
  };
}

module.exports = {
  EVALUATION_TIMEOUT_MS,
  GOLD_REVIEW_NOISE_REASONS,
  GOLD_REVIEW_UNKNOWN_REASONS,
  MINIMUM_PERFORMANCE_LABELS,
  MODEL_VERSION,
  RELEASE_STATUS,
  SUPPORTED_SOURCES,
  buildAlertContext,
  buildFeatureSnapshot,
  buildShadowDecision,
  calculateEvaluationMetrics,
  canonicalSource,
  classifyFailure,
  createLiveMultiSourceEvaluationService,
  directSourceMapping,
  feedbackErrorType,
  goldTrainingEligibility,
  isCorrectFeedbackResult,
  monitoringSourceFromRecord,
  observedNoiseDetection,
  operationalDimensions,
  safeJson,
  sourceMetadata,
  structuredSourceFamily,
  service: createLiveMultiSourceEvaluationService({ patternLearning: evidenceLearningService }),
};
