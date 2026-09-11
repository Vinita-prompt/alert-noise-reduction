const db = require('../config/db');
const { NOISE_EVIDENCE_CONFIG } = require('../config/noiseEvidence');
const { service: phaseOneService } = require('./noiseAnalysis.service');
const {
  assessReviewRisk,
  recommendationFor: calibratedRecommendationFor,
} = require('./noiseScoring.service');
const slackAlertStoreService = require('./slackAlertStore.service');
const accJiraReadService = require('./atlassian/accJiraRead.service');
const appDynamicsService = require('./appDynamics.service');
const grafanaService = require('./grafanaDashboard.service');
const { workspaceService: thousandEyesService } = require('./thousandEyesWorkspace.service');
const nagiosService = require('./nagios.service');
const {
  createSourceEvidenceAdapterRegistry,
  normalizeOperationsAlert,
  normalizeWindow,
} = require('./sourceEvidenceAdapters.service');
const { coalesceEvidenceJobs } = require('./noiseEvidenceQueue.service');

const FEEDBACK_VALUES = new Set(['correlation_correct', 'correlation_incorrect']);
const SOURCE_NAMES = Object.freeze({
  operations: 'JSM Operations',
  slack: 'Slack',
  jira: 'ACC Jira',
  appdynamics: 'AppDynamics',
  grafana: 'Grafana',
  thousandeyes: 'ThousandEyes',
  nagios: 'Nagios',
});

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function text(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return text(value).toLowerCase();
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const milliseconds = typeof value === 'number' ? value : toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return String(value).startsWith('/') ? String(value) : null;
  }
}

function nestedValues(value, keyPattern, depth = 0, results = []) {
  if (!value || depth > 5 || results.length >= 30) return results;
  if (Array.isArray(value)) {
    value.forEach((item) => nestedValues(item, keyPattern, depth + 1, results));
    return results;
  }
  if (typeof value !== 'object') return results;
  Object.entries(value).forEach(([key, item]) => {
    if (keyPattern.test(key) && ['string', 'number'].includes(typeof item) && text(item)) results.push(text(item));
    if (item && typeof item === 'object') nestedValues(item, keyPattern, depth + 1, results);
  });
  return results;
}

function normalizeEvidence(item = {}) {
  return {
    id: String(item.id || `${item.source || 'evidence'}:${item.type || 'record'}:${item.timestamp || item.title || 'unknown'}`),
    source: text(item.source) || 'Unknown',
    type: text(item.type) || 'evidence',
    timestamp: toIso(item.timestamp),
    title: text(item.title) || 'Correlated evidence',
    summary: text(item.summary) || null,
    severity: text(item.severity) || null,
    entity: text(item.entity) || null,
    url: safeUrl(item.url),
    correlationKey: text(item.correlationKey) || null,
    confidence: ['High', 'Medium', 'Low'].includes(item.confidence) ? item.confidence : 'Low',
    metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
  };
}

function groupIdentity(group, sourceIdentity = null, options = {}) {
  const alerts = group.alerts || [];
  const raw = alerts.flatMap((alert) => [alert.extraProperties, alert.sourceDetails, alert.sourceIdentifiers]);
  const alertNumbers = unique(alerts.map((alert) => alert.tinyId));
  const operationsIds = unique(alerts.map((alert) => alert.id));
  const descriptions = alerts.flatMap((alert) => [alert.title, alert.message, alert.description]);
  const jiraKeys = unique(descriptions.flatMap((value) => text(value).match(/\bACC-\d+\b/gi) || []).map((value) => value.toUpperCase()));
  const accepted = (key) => (sourceIdentity?.mappings?.[key] || []).filter((mapping) => (
    ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(mapping.level) && mapping.rejected !== true
  ));
  const appDynamicsMappings = accepted('appDynamics');
  const grafanaMappings = accepted('grafana');
  const thousandEyesMappings = accepted('thousandEyes');
  const nagiosMappings = accepted('nagios');
  return {
    strictIdentity: options.strictIdentity === true,
    alertNumbers,
    operationsIds,
    jiraKeys,
    applications: unique(alerts.flatMap((alert) => [alert.application, ...nestedValues(alert, /application|app.?name/i)]).concat(appDynamicsMappings.filter((item) => item.sourceEntityType === 'APPLICATION').map((item) => item.sourceEntityName))),
    services: unique(alerts.flatMap((alert) => [alert.service, ...nestedValues(alert, /service(?:.?name)?|business.?transaction/i)]).concat(appDynamicsMappings.map((item) => item.sourceEntityName))),
    hosts: unique(alerts.flatMap((alert) => [alert.sourceDetails?.host, ...nestedValues(alert, /^(host|hostname|host_name)$/i)]).concat(nagiosMappings.map((item) => item.metadata?.host))),
    environments: unique(alerts.flatMap((alert) => [alert.environment, ...nestedValues(alert, /environment|^env$/i)])),
    rules: unique(raw.flatMap((value) => nestedValues(value, /alert.?rule|rule.?name|health.?rule/i))),
    sourceIds: unique(alerts.flatMap((alert) => [alert.alias, ...nestedValues(alert, /^(source.?id|event.?id|test.?id|rule.?id|dashboard.?uid|panel.?uid)$/i)]).concat(grafanaMappings.map((item) => item.sourceEntityId), thousandEyesMappings.map((item) => item.sourceEntityId))),
    testIds: unique(raw.flatMap((value) => nestedValues(value, /test.?id/i)).concat(thousandEyesMappings.map((item) => item.metadata?.testId))),
    agentIds: unique(raw.flatMap((value) => nestedValues(value, /agent.?id/i)).concat(thousandEyesMappings.flatMap((item) => item.metadata?.agentIds || []))),
    dashboardUids: unique(raw.flatMap((value) => nestedValues(value, /dashboard.?uid/i)).concat(grafanaMappings.map((item) => item.metadata?.dashboardUid))),
    panelIds: unique(raw.flatMap((value) => nestedValues(value, /panel.?id|panel.?uid/i)).concat(grafanaMappings.map((item) => item.metadata?.panelId))),
    sources: unique(alerts.flatMap((alert) => [alert.sourceSystem, alert.source]).concat(group.sources || [])),
    sourceMappings: { appDynamics: appDynamicsMappings, grafana: grafanaMappings, thousandEyes: thousandEyesMappings, nagios: nagiosMappings },
  };
}

function buildWindows(group, config = NOISE_EVIDENCE_CONFIG) {
  const buffer = config.correlationWindowMinutes * 60 * 1000;
  const occurrences = (group.alerts || [])
    .map((alert) => toMs(alert.createdAt || alert.firstOccurredAt))
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  const selected = occurrences.length <= config.maxAlertWindows
    ? occurrences
    : occurrences.filter((_, index) => index === 0 || index === occurrences.length - 1 || index % Math.ceil(occurrences.length / (config.maxAlertWindows - 2)) === 0).slice(0, config.maxAlertWindows);
  return selected.map((timestamp) => ({
    from: new Date(timestamp - buffer).toISOString(),
    to: new Date(timestamp + buffer).toISOString(),
  }));
}

function withinWindows(timestamp, windows) {
  const value = toMs(timestamp);
  if (value === null) return false;
  return windows.some((window) => value >= toMs(window.from) && value <= toMs(window.to));
}

function exactMatch(value, candidates) {
  const normalized = canonical(value);
  return Boolean(normalized && candidates.some((candidate) => canonical(candidate) === normalized));
}

function containsExactToken(haystack, token) {
  const normalizedHaystack = canonical(haystack);
  const normalizedToken = canonical(token);
  if (!normalizedHaystack || normalizedToken.length < 3) return false;
  return normalizedHaystack.split(/[^a-z0-9._:-]+/).includes(normalizedToken) || normalizedHaystack.includes(`alert #${normalizedToken}`);
}

function confidenceForScore(score) {
  if (score >= 70) return 'High';
  if (score >= 45) return 'Medium';
  return 'Low';
}

function relationship(evidence, score, reasons, status = 'candidate') {
  return {
    evidenceId: evidence.id,
    source: evidence.source,
    confidence: confidenceForScore(score),
    score: Math.min(100, score),
    relationship: status,
    evidence: unique(reasons),
  };
}

function operationsEvidence(group) {
  return (group.alerts || []).flatMap((alert) => {
    const entity = alert.service || alert.application || alert.sourceDetails?.host || null;
    const created = normalizeEvidence({
      id: `operations:${alert.id}:created`,
      source: SOURCE_NAMES.operations,
      type: 'alert_created',
      timestamp: alert.createdAt,
      title: `Alert #${alert.tinyId || alert.id} created`,
      summary: alert.title || alert.message || alert.description,
      severity: alert.priority,
      entity,
      url: `/live-alerts/${encodeURIComponent(alert.id)}`,
      correlationKey: alert.id,
      confidence: 'High',
      metadata: { canonicalOperationsId: alert.id, alertNumber: alert.tinyId || null, status: alert.status || null },
    });
    if (!alert.closeTime) return [created];
    return [created, normalizeEvidence({
      id: `operations:${alert.id}:closed`,
      source: SOURCE_NAMES.operations,
      type: 'alert_closed',
      timestamp: alert.closeTime,
      title: `Alert #${alert.tinyId || alert.id} closed`,
      summary: alert.title || alert.message || alert.description,
      severity: alert.priority,
      entity,
      url: `/live-alerts/${encodeURIComponent(alert.id)}`,
      correlationKey: alert.id,
      confidence: 'High',
      metadata: { canonicalOperationsId: alert.id, alertNumber: alert.tinyId || null, status: alert.status || null },
    })];
  });
}

function percentile(values, position) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function operationsSummary(group) {
  const alerts = group.alerts || [];
  const durations = alerts.map((alert) => {
    const start = toMs(alert.createdAt);
    const end = toMs(alert.closeTime);
    return start !== null && end !== null && end >= start ? end - start : null;
  }).filter(Number.isFinite);
  const closed = alerts.filter((alert) => alert.closeTime || /closed|resolved/i.test(alert.status || ''));
  const acknowledged = alerts.filter((alert) => alert.acknowledged === true);
  return {
    count: alerts.length,
    firstSeen: group.firstSeen || null,
    lastSeen: group.lastSeen || null,
    priorities: unique(alerts.map((alert) => alert.priority)),
    sources: unique(alerts.flatMap((alert) => [alert.sourceSystem, alert.source])),
    statuses: unique(alerts.map((alert) => alert.status)),
    acknowledgementRate: alerts.length ? Math.round((acknowledged.length / alerts.length) * 100) : 0,
    closureRate: alerts.length ? Math.round((closed.length / alerts.length) * 100) : 0,
    averageActiveDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    medianActiveDurationMs: percentile(durations, 0.5),
  };
}

function sourceResult(source, status, evidence = [], relationships = [], extra = {}) {
  return {
    source,
    status,
    evidence: evidence.map(normalizeEvidence),
    relationships,
    readOnly: true,
    ...extra,
  };
}

async function collectSlack(group, identity, windows, dependencies) {
  if (!identity.alertNumbers.length || !dependencies.slackStore?.getCorrelationsByAlertNumbers) return sourceResult(SOURCE_NAMES.slack, 'not_applicable');
  const correlations = await dependencies.slackStore.getCorrelationsByAlertNumbers(identity.alertNumbers.slice(0, 100), { includeMessages: true });
  const evidence = [];
  const relationships = [];
  identity.alertNumbers.forEach((alertNumber) => {
    const item = correlations?.[alertNumber];
    (item?.messages || []).slice(0, dependencies.config.maxEvidencePerSource).forEach((message, index) => {
      const timestamp = message.messageAt || message.timestamp || message.messageTs;
      const normalized = normalizeEvidence({
        id: `slack:${message.messageTs || timestamp || alertNumber}:${index}`,
        source: SOURCE_NAMES.slack,
        type: message.threadTs && message.threadTs !== message.messageTs ? 'thread_reply' : 'message',
        timestamp,
        title: `Slack context for Alert #${alertNumber}`,
        summary: message.message || message.text || message.rawMessage,
        entity: message.author?.name || null,
        url: message.slackPermalink,
        correlationKey: `alert:${alertNumber}`,
        confidence: 'High',
        metadata: { alertNumber, replyCount: Number(message.replyCount || 0), threadTs: message.threadTs || null },
      });
      evidence.push(normalized);
      const reasons = [`Exact Alert #${alertNumber} reference`];
      let score = 80;
      if (withinWindows(timestamp, windows)) { score += 15; reasons.push('Timestamp within the configured 15-minute correlation window'); }
      relationships.push(relationship(normalized, score, reasons, 'confirmed'));
    });
  });
  const boundedEvidence = evidence.slice(0, dependencies.config.maxEvidencePerSource);
  const acceptedIds = new Set(boundedEvidence.map((item) => item.id));
  return sourceResult(
    SOURCE_NAMES.slack,
    boundedEvidence.length ? (evidence.length > boundedEvidence.length ? 'partial' : 'working') : 'no_evidence',
    boundedEvidence,
    relationships.filter((item) => acceptedIds.has(item.evidenceId)),
    { query: 'exact alert number', bounded: true, totalMatches: evidence.length },
  );
}

function jiraText(issue) {
  return [issue.summary, issue.description, issue.resolution, issue.howResolved].filter(Boolean).join(' ');
}

async function collectJira(group, identity, windows, dependencies) {
  if (!dependencies.jiraService?.listEvidenceCandidates && !dependencies.jiraService?.listIncidents) return sourceResult(SOURCE_NAMES.jira, 'not_applicable');
  const response = dependencies.jiraService.listEvidenceCandidates
    ? await dependencies.jiraService.listEvidenceCandidates({
      from: windows[0]?.from,
      to: windows.at(-1)?.to,
      limit: dependencies.config.maxJiraCandidates,
    })
    : await dependencies.jiraService.listIncidents({ page: 1, pageSize: 25 });
  const evidence = [];
  const relationships = [];
  for (const issue of (response.items || []).slice(0, dependencies.config.maxJiraCandidates)) {
    const directNumbers = unique((issue.relatedAlerts || []).map((item) => item.alertNumber));
    const exactAlertNumber = directNumbers.find((number) => identity.alertNumbers.includes(String(number)));
    const exactJiraKey = identity.jiraKeys.includes(String(issue.key || '').toUpperCase());
    const body = jiraText(issue);
    const exactEntity = [...identity.services, ...identity.applications, ...identity.hosts].find((value) => containsExactToken(body, value));
    const timestamp = issue.createdAt || issue.updatedAt || issue.resolvedAt;
    const timeMatch = withinWindows(timestamp, windows) || withinWindows(issue.updatedAt, windows) || withinWindows(issue.resolvedAt, windows);
    if (!exactAlertNumber && !exactJiraKey && !(exactEntity && timeMatch)) continue;
    const confirmed = Boolean(exactAlertNumber || exactJiraKey);
    const reasons = [];
    let score = 0;
    if (exactAlertNumber) { score += 80; reasons.push(`Exact Alert #${exactAlertNumber} reference`); }
    if (exactJiraKey) { score += 80; reasons.push(`Exact Jira key ${issue.key}`); }
    if (exactEntity) { score += 35; reasons.push(`Exact entity match: ${exactEntity}`); }
    if (timeMatch) { score += 15; reasons.push('Jira activity overlaps the configured correlation window'); }
    const normalized = normalizeEvidence({
      id: `jira:${issue.key}`,
      source: SOURCE_NAMES.jira,
      type: confirmed ? 'confirmed_issue_relationship' : 'candidate_issue_relationship',
      timestamp,
      title: `${issue.key} · ${issue.summary || issue.issueType || 'ACC issue'}`,
      summary: [issue.issueType, issue.status, issue.resolution].filter(Boolean).join(' · '),
      severity: issue.priority,
      entity: exactEntity || issue.key,
      url: `/incidents/${encodeURIComponent(issue.key)}`,
      correlationKey: exactAlertNumber ? `alert:${exactAlertNumber}` : `jira:${issue.key}`,
      confidence: confidenceForScore(score),
      metadata: { issueKey: issue.key, issueType: issue.issueType || null, status: issue.status || null, relationship: confirmed ? 'confirmed' : 'candidate' },
    });
    evidence.push(normalized);
    relationships.push(relationship(normalized, score, reasons, confirmed ? 'confirmed' : 'candidate'));
  }
  return sourceResult(SOURCE_NAMES.jira, evidence.length ? 'partial' : 'no_evidence', evidence, relationships, { bounded: true, inspected: Math.min(response.items?.length || 0, dependencies.config.maxJiraCandidates), issueTypesInspected: response.typesInspected || ['Incidents'], relationshipPolicy: 'exact reference confirms; entity plus time remains candidate' });
}

function relevantSource(identity, name) {
  return identity.sources.some((source) => canonical(source).includes(canonical(name)));
}

async function collectAppDynamics(group, identity, windows, dependencies) {
  const resolved = identity.sourceMappings?.appDynamics?.find((item) => item.sourceEntityType === 'APPLICATION') || identity.sourceMappings?.appDynamics?.[0];
  if (identity.strictIdentity && !resolved) return sourceResult(SOURCE_NAMES.appdynamics, 'not_applicable', [], [], { reason: 'Exact or strong AppDynamics identity is required for automatic evidence collection.' });
  if ((!relevantSource(identity, 'appd') && !resolved) || !dependencies.appDynamicsService?.getWorkspaceApplication) return sourceResult(SOURCE_NAMES.appdynamics, 'not_applicable');
  const application = resolved?.sourceEntityId || resolved?.sourceEntityName || identity.applications[0];
  if (!application) return sourceResult(SOURCE_NAMES.appdynamics, 'partial', [], [], { reason: 'Operations evidence did not provide an exact AppDynamics application identifier.' });
  const response = await dependencies.appDynamicsService.getWorkspaceApplication(application, { range: dependencies.range || '24h' });
  const records = (Array.isArray(response.events) ? response.events : (response.events?.items || response.eventData?.items || [])).filter((item) => withinWindows(item.eventTime || item.timestamp || item.startTime, windows)).slice(0, dependencies.config.maxEvidencePerSource);
  const evidence = records.map((item, index) => normalizeEvidence({
    id: `appdynamics:${item.id || item.eventId || index}`,
    source: SOURCE_NAMES.appdynamics,
    type: item.type || item.eventType || 'event',
    timestamp: item.eventTime || item.timestamp || item.startTime,
    title: item.name || item.title || item.summary || 'AppDynamics event',
    summary: item.eventMessage || item.description || item.summary,
    severity: item.severity,
    entity: item.tierName || item.nodeName || application,
    url: item.sourceUrl || response.application?.sourceUrl,
    correlationKey: `application:${application}`,
    confidence: 'Medium',
    metadata: { application, healthRule: item.healthRule || item.healthRuleName || null, tier: item.tierName || null, node: item.nodeName || null },
  }));
  const relationships = evidence.map((item) => relationship(item, resolved ? 88 : 55, [resolved ? `${resolved.level} source identity mapping: ${resolved.sourceEntityName}` : `Exact application match: ${application}`, 'Timestamp within the configured 15-minute correlation window'], resolved ? 'confirmed' : 'candidate'));
  return sourceResult(SOURCE_NAMES.appdynamics, evidence.length ? 'working' : 'no_evidence', evidence, relationships, { bounded: true, application, identityMapping: resolved || null });
}

async function collectGrafana(group, identity, windows, dependencies) {
  const resolved = identity.sourceMappings?.grafana?.[0];
  if (identity.strictIdentity && !resolved) return sourceResult(SOURCE_NAMES.grafana, 'not_applicable', [], [], { reason: 'Exact or strong Grafana identity is required for automatic evidence collection.' });
  if ((!relevantSource(identity, 'grafana') && !resolved) || !dependencies.grafanaService) return sourceResult(SOURCE_NAMES.grafana, 'not_applicable');
  const search = resolved?.sourceEntityId || resolved?.sourceEntityName || identity.rules[0] || identity.sourceIds[0];
  if (!search) return sourceResult(SOURCE_NAMES.grafana, 'partial', [], [], { reason: 'Operations evidence did not provide an exact Grafana rule or UID.' });
  const response = await dependencies.grafanaService.listGrafanaWorkspaceAlertRules({ search, page: 1, pageSize: 25 });
  const rules = (response.items || []).filter((rule) => resolved ? (String(rule.uid) === String(resolved.sourceEntityId) || exactMatch(rule.title, [resolved.sourceEntityName])) : (exactMatch(rule.uid, identity.sourceIds) || exactMatch(rule.title, identity.rules)));
  const evidence = rules.slice(0, dependencies.config.maxEvidencePerSource).map((rule) => normalizeEvidence({
    id: `grafana:${rule.uid}`,
    source: SOURCE_NAMES.grafana,
    type: 'alert_rule',
    timestamp: rule.updatedAt,
    title: rule.title,
    summary: [rule.folderTitle, rule.ruleGroup, rule.condition].filter(Boolean).join(' · '),
    entity: rule.annotations?.service || rule.labels?.service || null,
    url: rule.dashboard?.url,
    correlationKey: `grafana-rule:${rule.uid}`,
    confidence: 'High',
    metadata: { ruleUid: rule.uid, dashboardUid: rule.dashboard?.uid || null, panelId: rule.dashboard?.panelId || null, folder: rule.folderTitle || null },
  }));
  const relationships = evidence.map((item) => relationship(item, resolved ? 90 : 75, [resolved ? `${resolved.level} source identity mapping: ${resolved.sourceEntityName}` : `Exact Grafana rule/UID match: ${search}`], 'confirmed'));
  return sourceResult(SOURCE_NAMES.grafana, evidence.length ? 'working' : 'no_evidence', evidence, relationships, { bounded: true, search, identityMapping: resolved || null });
}

async function collectThousandEyes(group, identity, windows, dependencies) {
  const resolved = identity.sourceMappings?.thousandEyes?.[0];
  if (identity.strictIdentity && !resolved) return sourceResult(SOURCE_NAMES.thousandeyes, 'not_applicable', [], [], { reason: 'Exact or strong ThousandEyes identity is required for automatic evidence collection.' });
  if ((!relevantSource(identity, 'thousandeyes') && !resolved) || !dependencies.thousandEyesService?.getAlert) return sourceResult(SOURCE_NAMES.thousandeyes, 'not_applicable');
  const sourceId = resolved?.metadata?.alertId || resolved?.sourceEntityId || identity.sourceIds[0];
  if (!sourceId) return sourceResult(SOURCE_NAMES.thousandeyes, 'partial', [], [], { reason: 'Operations evidence did not provide an exact ThousandEyes alert identifier.' });
  const response = await dependencies.thousandEyesService.getAlert(sourceId, { range: '24h' });
  const item = response.alert;
  if (!item) return sourceResult(SOURCE_NAMES.thousandeyes, 'no_evidence');
  const normalized = normalizeEvidence({
    id: `thousandeyes:${item.id}`,
    source: SOURCE_NAMES.thousandeyes,
    type: item.type || 'alert',
    timestamp: item.startDate,
    title: item.name || item.ruleName || 'ThousandEyes alert',
    summary: [item.testName, item.ruleName, item.state].filter(Boolean).join(' · '),
    severity: item.severity,
    entity: item.testName,
    url: item.sourceLink,
    correlationKey: `thousandeyes:${item.id}`,
    confidence: 'High',
    metadata: { alertId: item.id, testId: item.testId || null, ruleId: item.ruleId || null, agentIds: (response.agents || []).map((agent) => agent.id).filter(Boolean) },
  });
  const reasons = [`Exact ThousandEyes alert identifier: ${sourceId}`];
  let score = 80;
  if (withinWindows(item.startDate, windows)) { score += 15; reasons.push('Timestamp within the configured 15-minute correlation window'); }
  return sourceResult(SOURCE_NAMES.thousandeyes, 'working', [normalized], [relationship(normalized, score, reasons, 'confirmed')], { bounded: true, apiVersion: 'v7' });
}

async function collectNagios(group, identity, windows, dependencies) {
  const resolved = identity.sourceMappings?.nagios?.[0];
  if (identity.strictIdentity && !resolved) return sourceResult(SOURCE_NAMES.nagios, 'not_applicable', [], [], { reason: 'Exact or strong Nagios DC01/DC02 identity is required for automatic evidence collection.' });
  if ((!relevantSource(identity, 'nagios') && !resolved) || !dependencies.nagiosService?.listWorkspaceRecords) return sourceResult(SOURCE_NAMES.nagios, 'not_applicable');
  const compositeIdentifier = identity.sourceIds.find((value) => value.includes('_'));
  const separator = compositeIdentifier?.indexOf('_') ?? -1;
  const compositeHost = separator > 0 ? compositeIdentifier.slice(0, separator) : null;
  const compositeService = separator > 0 ? compositeIdentifier.slice(separator + 1) : null;
  const host = resolved?.metadata?.host || identity.hosts[0] || compositeHost;
  const service = resolved?.metadata?.service || compositeService || identity.services[0];
  if (!host && !service) return sourceResult(SOURCE_NAMES.nagios, 'partial', [], [], { reason: 'Operations evidence did not provide an exact Nagios host or service.' });
  const environment = canonical(resolved?.metadata?.instance || identity.environments[0]);
  const instances = environment.includes('02') ? ['d02'] : environment.includes('01') ? ['d01'] : ['d01', 'd02'];
  const type = service ? 'service' : 'host';
  const search = service || host;
  const matches = [];
  const inspectedInstances = [];
  for (const instance of instances) {
    const response = await dependencies.nagiosService.listWorkspaceRecords(instance, type, { search, status: 'all', page: 1, pageSize: 25 });
    inspectedInstances.push(response.instance?.environment || instance.toUpperCase());
    matches.push(...(response.items || []).filter((item) => (
      (!host || exactMatch(item.hostName, [host]))
      && (!service || exactMatch(item.serviceDescription, [service]))
      && withinWindows(item.lastStateChange || item.lastCheck, windows)
    )).map((item) => ({ ...item, correlationInstance: instance })));
    if (matches.length) break;
  }
  const evidence = matches.slice(0, dependencies.config.maxEvidencePerSource).map((item) => normalizeEvidence({
    id: `nagios:${item.correlationInstance}:${item.entityId || item.id}`,
    source: SOURCE_NAMES.nagios,
    type,
    timestamp: item.lastStateChange || item.lastCheck,
    title: type === 'service' ? `${item.hostName} · ${item.serviceDescription}` : item.hostName,
    summary: item.pluginOutput,
    severity: item.status,
    entity: item.entityId,
    url: item.sourceUrl,
    correlationKey: type === 'service' ? `nagios:${item.hostName}:${item.serviceDescription}` : `nagios:${item.hostName}`,
    confidence: 'Medium',
    metadata: { instance: item.correlationInstance, host: item.hostName, service: item.serviceDescription || null, status: item.status, performanceData: item.performanceData || null },
  }));
  const relationships = evidence.map((item) => {
    const reasons = [service ? `Exact Nagios host/service match: ${host || item.metadata.host} / ${service}` : `Exact Nagios host match: ${host}`];
    let score = resolved ? 88 : service ? 65 : 55;
    if (withinWindows(item.timestamp, windows)) { score += 15; reasons.push('State change within the configured 15-minute correlation window'); }
    if (resolved) reasons.push(`${resolved.level} source identity mapping: ${resolved.sourceEntityName}`);
    return relationship(item, score, reasons, resolved ? 'confirmed' : 'candidate');
  });
  return sourceResult(SOURCE_NAMES.nagios, evidence.length ? 'working' : 'no_evidence', evidence, relationships, { bounded: true, inspectedInstances, identityMapping: resolved || null });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function withSourceTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = safeError('The bounded source evidence request timed out.', 'SOURCE_EVIDENCE_TIMEOUT', 504);
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function acceptedSourceMappings(sourceIdentity = {}) {
  return Object.values(sourceIdentity.mappings || {}).flat().filter((mapping) => (
    ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(String(mapping.level || '').toUpperCase())
    && mapping.rejected !== true
    && mapping.usableForSourceValidation !== false
  ));
}

function occurrenceWindow(alert, investigationWindow, index) {
  const id = String(alert.id || alert.canonicalOperationsId || '');
  const alertNumber = String(alert.tinyId || alert.alertNumber || '');
  const candidate = (investigationWindow?.windows || []).find((window) => (
    (id && String(window.canonicalOperationsId || '') === id)
    || (alertNumber && String(window.alertNumber || '') === alertNumber)
  )) || investigationWindow?.windows?.[index];
  if (!candidate) return null;
  return normalizeWindow({
    afterMinutes: investigationWindow.afterMinutes,
    beforeMinutes: investigationWindow.beforeMinutes,
    from: candidate.before?.from || candidate.during?.from,
    to: candidate.after?.available === false ? candidate.during?.to : candidate.after?.to || candidate.during?.to,
  });
}

function balancedEvidenceSample(items, maximum) {
  if (items.length <= maximum) return items;
  const buckets = new Map();
  items.forEach((item) => {
    const key = `${item.type || 'record'}:${item.metadata?.metric || item.metadata?.status || 'general'}`;
    const values = buckets.get(key) || [];
    values.push(item);
    buckets.set(key, values);
  });
  const sample = [];
  const groups = [...buckets.values()];
  let index = 0;
  while (sample.length < maximum && groups.some((group) => index < group.length)) {
    groups.forEach((group) => {
      if (sample.length < maximum && group[index]) sample.push(group[index]);
    });
    index += 1;
  }
  return sample.sort((left, right) => (toMs(left.timestamp) || 0) - (toMs(right.timestamp) || 0));
}

function combinedAdapterResult(source, results, config) {
  const evidence = balancedEvidenceSample(results.flatMap((result) => result.evidence || []), config.maxEvidencePerSource);
  const acceptedIds = new Set(evidence.map((item) => item.id));
  const relationships = results.flatMap((result) => result.relationships || [])
    .filter((item) => !item.evidenceId || acceptedIds.has(item.evidenceId));
  const lifecycle = results.flatMap((result) => result.lifecycle || []).slice(0, config.maxEvidencePerSource);
  const pipelineStates = results.map((result) => result.pipelineState);
  const pipelineState = pipelineStates.includes('RECORDS_FOUND') ? 'RECORDS_FOUND'
    : pipelineStates.includes('QUERY_FAILED') ? 'QUERY_FAILED'
      : pipelineStates.includes('NO_RECORDS') ? 'NO_RECORDS' : 'NOT_QUERIED';
  const status = evidence.length ? 'working'
    : pipelineState === 'QUERY_FAILED' ? 'error'
      : pipelineState === 'NOT_QUERIED' ? 'not_applicable' : 'no_evidence';
  const failureReasons = unique(results.map((result) => result.failureReason));
  return sourceResult(source, status, evidence, relationships, {
    adapter: results[0]?.adapter || `${source.replace(/\s+/g, '')}EvidenceAdapter`,
    bounded: true,
    diagnostics: {
      occurrences: results.map((result) => ({
        ...result.diagnostics,
        occurrenceId: result.occurrenceId,
        alertNumber: result.alertNumber,
      })),
    },
    evidenceState: evidence.length ? 'RECORDS_FOUND' : pipelineState,
    failureReason: failureReasons[0] || null,
    failureReasons,
    identityMapping: results.find((result) => result.identityMapping)?.identityMapping || null,
    lifecycle,
    matchedRecords: results.reduce((sum, result) => sum + Number(result.matchedRecords || 0), 0),
    pipelineState,
    query: results.map((result) => result.query).filter(Boolean),
    recordsReturned: results.reduce((sum, result) => sum + Number(result.recordsReturned || 0), 0),
  });
}

async function collectSharedAdapterEvidence({ adapters, alerts, investigationWindow, mappings, config, range }) {
  const jobs = [];
  alerts.forEach((rawAlert, occurrenceIndex) => {
    const window = occurrenceWindow(rawAlert, investigationWindow, occurrenceIndex);
    if (!window?.from || !window?.to) return;
    const alert = normalizeOperationsAlert(rawAlert, null);
    adapters.forEach((adapter) => jobs.push({ adapter, alert, mappings, window }));
  });
  const coalescedJobs = coalesceEvidenceJobs(jobs);
  const results = await mapWithConcurrency(coalescedJobs, config.maxConcurrency, async ({ adapter, alert, occurrenceIds, window }) => {
    const identityMapping = adapter.resolveIdentity(alert, mappings) || null;
    const result = await withSourceTimeout(
      adapter.queryEvidence(alert, window, { mappings, range }),
      config.sourceTimeoutMs,
    ).catch((error) => ({
      adapter: adapter.name,
      diagnostics: { failureReason: error.safeMessage || error.message, queryWindow: window },
      evidence: [],
      evidenceState: 'QUERY_FAILED',
      failureReason: error.safeMessage || error.message || 'SOURCE_QUERY_FAILED',
      // A transport timeout does not invalidate a deterministic mapping. Keep it
      // visible so diagnostics distinguish "exact mapping, query failed" from
      // "adapter was never eligible to run".
      identityMapping,
      lifecycle: [],
      matchedRecords: 0,
      pipelineState: 'QUERY_FAILED',
      query: null,
      recordsReturned: 0,
      relationships: [],
      source: adapter.source,
      status: 'error',
    }));
    return {
      ...result,
      occurrenceId: occurrenceIds.length === 1 ? occurrenceIds[0] : null,
      occurrenceIds,
      alertNumber: alert.alertNumber,
      diagnostics: {
        ...(result.diagnostics || {}),
        occurrenceIds,
        coalescedOccurrenceCount: occurrenceIds.length,
      },
    };
  });
  return adapters.map((adapter) => ({
    ...combinedAdapterResult(
    adapter.source,
    results.filter((result) => result.source === adapter.source),
    config,
    ),
    queryReuse: {
      requestedWindows: jobs.filter((job) => job.adapter.source === adapter.source).length,
      executedWindows: coalescedJobs.filter((job) => job.adapter.source === adapter.source).length,
      requestsAvoided: Math.max(0, jobs.filter((job) => job.adapter.source === adapter.source).length - coalescedJobs.filter((job) => job.adapter.source === adapter.source).length),
    },
  }));
}

function correlationSummary(sourceResults) {
  const relationships = sourceResults.flatMap((source) => source.relationships || []);
  const accepted = relationships.filter((item) => item.confidence !== 'Low');
  const distinctSources = unique(accepted.map((item) => item.source));
  const highest = accepted.reduce((maximum, item) => Math.max(maximum, item.score || 0), 0);
  const score = Math.min(100, highest + Math.max(0, distinctSources.length - 1) * 8);
  return {
    level: confidenceForScore(score),
    score,
    relationshipCount: accepted.length,
    sourceCount: distinctSources.length,
    reasons: unique(accepted.flatMap((item) => item.evidence || [])).slice(0, 10),
  };
}

function evidenceAssessment(group, sourceResults, summary) {
  const supporting = [];
  const contradicting = [];
  const patternLabels = (group.labels || [group.classification]).filter((label) => ['duplicate', 'recurring', 'flapping', 'flapping_like', 'auto_resolved'].includes(label));
  patternLabels.forEach((label) => supporting.push({ signal: `${label.replaceAll('_', ' ')} pattern`, detail: `${group.occurrences} Operations occurrences were deterministically grouped from historical behavior.` }));
  const operationSummary = operationsSummary(group);
  if (operationSummary.acknowledgementRate === 0) supporting.push({ signal: 'No human acknowledgement', detail: 'No human acknowledgement was present in the available Operations group.' });
  if (group.priority && /^(P1|P2|Critical)$/i.test(group.priority)) contradicting.push({ signal: 'High operational priority', detail: `${group.priority} raises Review Risk without reducing Noise Likelihood.` });
  if (operationSummary.acknowledgementRate > 0) supporting.push({ signal: 'Human acknowledgement workload', detail: `${operationSummary.acknowledgementRate}% of grouped alerts were acknowledged; repeated handling is a Human Toil signal.` });
  const jiraConfirmed = sourceResults.find((result) => result.source === SOURCE_NAMES.jira)?.relationships?.some((item) => item.relationship === 'confirmed');
  if (jiraConfirmed) contradicting.push({ signal: 'Confirmed Jira relationship', detail: 'An exact alert or Jira identifier links this pattern to an ACC issue.' });
  if (summary.sourceCount >= 2) contradicting.push({ signal: 'Multi-source confirmation', detail: `${summary.sourceCount} external sources provide medium/high correlation evidence.` });
  if (!summary.relationshipCount) supporting.push({ signal: 'No external confirmation', detail: 'No medium/high cross-source relationship was found in the bounded evidence queries.' });
  return { supporting, contradicting };
}

function refinedRecommendation(group, confidence, assessment, reviewRisk) {
  const risk = reviewRisk || assessReviewRisk(group, {
    correlationConfidence: confidence?.score,
    incidentBacked: assessment?.contradicting?.some((item) => item.signal === 'Confirmed Jira relationship'),
    strongCrossSourceEvidence: Number(confidence?.score || 0) >= 60,
  });
  return calibratedRecommendationFor(Number(group.noiseLikelihood ?? group.noiseScore ?? 0), risk);
}

function evidenceTimeline(sourceResults) {
  return sourceResults.flatMap((result) => result.evidence || [])
    .filter((item) => item.timestamp)
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp))
    .map((item) => ({ ...item, relationship: resultRelationship(sourceResults, item.id) }));
}

function resultRelationship(sourceResults, evidenceId) {
  return sourceResults.flatMap((result) => result.relationships || []).find((item) => item.evidenceId === evidenceId) || null;
}

async function defaultFeedbackStore() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS noise_evidence_feedback (
      analysis_group_id TEXT PRIMARY KEY,
      feedback TEXT NOT NULL,
      user_identity TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  return {
    async get(groupId) {
      const result = await db.query('SELECT analysis_group_id, feedback, user_identity, updated_at FROM noise_evidence_feedback WHERE analysis_group_id = $1', [groupId]);
      const row = result.rows[0];
      return row ? { analysisGroupId: row.analysis_group_id, feedback: row.feedback, userIdentity: row.user_identity || null, timestamp: row.updated_at } : null;
    },
    async save(groupId, feedback) {
      const result = await db.query(`
        INSERT INTO noise_evidence_feedback (analysis_group_id, feedback, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (analysis_group_id) DO UPDATE SET feedback = EXCLUDED.feedback, updated_at = NOW()
        RETURNING analysis_group_id, feedback, user_identity, updated_at
      `, [groupId, feedback]);
      const row = result.rows[0];
      return { analysisGroupId: row.analysis_group_id, feedback: row.feedback, userIdentity: row.user_identity || null, timestamp: row.updated_at };
    },
  };
}

function createNoiseEvidenceService({
  config = NOISE_EVIDENCE_CONFIG,
  phase1Service = phaseOneService,
  slackStore = slackAlertStoreService,
  jiraService = accJiraReadService,
  appDynamicsService: appd = appDynamicsService,
  grafanaService: grafana = grafanaService,
  thousandEyesService: thousandEyes = thousandEyesService,
  nagiosService: nagios = nagiosService,
  feedbackStoreFactory = defaultFeedbackStore,
  adapterRegistry = null,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  let feedbackStorePromise;
  const dependencies = { config, slackStore, jiraService, appDynamicsService: appd, grafanaService: grafana, thousandEyesService: thousandEyes, nagiosService: nagios };
  const sharedAdapters = adapterRegistry || createSourceEvidenceAdapterRegistry({
    appDynamics: appd,
    grafana,
    jira: jiraService,
    nagios,
    slack: slackStore,
    thousandEyes,
  });

  async function getFeedbackStore() {
    if (!feedbackStorePromise) feedbackStorePromise = Promise.resolve(feedbackStoreFactory());
    return feedbackStorePromise;
  }

  async function getEvidence(groupId, options = {}) {
    const id = String(groupId || '').trim();
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '7d';
    const strictIdentity = options.strictIdentity === true;
    const identityVersion = options.sourceIdentity?.canonicalEntity?.entityId || 'unresolved';
    const occurrenceSignature = (options.occurrences || []).map((alert) => alert.id || alert.tinyId).join(',');
    const windowSignature = (options.investigationWindow?.windows || []).map((window) => `${window.before?.from || ''}:${window.after?.to || window.during?.to || ''}`).join(',');
    const cacheKey = `${range}:${id}:${strictIdentity ? 'strict' : 'standard'}:${identityVersion}:${occurrenceSignature}:${windowSignature}`;
    const cached = cache.get(cacheKey);
    if (!options.refresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) return { ...cached.value, cache: { ...cached.value.cache, hit: true } };
    const startedAt = now();
    const phaseOne = await phase1Service.getGroup(id, { range });
    const group = phaseOne.group;
    const identity = groupIdentity(group, options.sourceIdentity, { strictIdentity });
    const windows = buildWindows(group, config);
    const operations = sourceResult(SOURCE_NAMES.operations, 'working', operationsEvidence(group), [], { summary: operationsSummary(group), authoritative: true, bounded: true });
    let external;
    const useSharedAdapters = Array.isArray(options.occurrences)
      && options.occurrences.length > 0
      && Array.isArray(options.investigationWindow?.windows);
    if (useSharedAdapters) {
      external = await collectSharedAdapterEvidence({
        adapters: sharedAdapters.adapters,
        alerts: options.occurrences,
        investigationWindow: options.investigationWindow,
        mappings: acceptedSourceMappings(options.sourceIdentity),
        config,
        range,
      });
    } else {
      const tasks = [
        [SOURCE_NAMES.slack, () => collectSlack(group, identity, windows, { ...dependencies, range })],
        [SOURCE_NAMES.jira, () => collectJira(group, identity, windows, { ...dependencies, range })],
        [SOURCE_NAMES.appdynamics, () => collectAppDynamics(group, identity, windows, { ...dependencies, range })],
        [SOURCE_NAMES.grafana, () => collectGrafana(group, identity, windows, { ...dependencies, range })],
        [SOURCE_NAMES.thousandeyes, () => collectThousandEyes(group, identity, windows, { ...dependencies, range })],
        [SOURCE_NAMES.nagios, () => collectNagios(group, identity, windows, { ...dependencies, range })],
      ];
      external = await mapWithConcurrency(tasks, config.maxConcurrency, async ([source, task]) => {
        const sourceStartedAt = now();
        try {
          const result = await withSourceTimeout(task(), config.sourceTimeoutMs);
          return { ...result, executionTimeMs: Math.max(0, now() - sourceStartedAt) };
        } catch (error) {
          return sourceResult(source, 'error', [], [], { executionTimeMs: Math.max(0, now() - sourceStartedAt), safeError: error.safeMessage || error.message || 'Evidence lookup failed.' });
        }
      });
    }
    const sources = [operations, ...external];
    const confidence = correlationSummary(external);
    const assessment = evidenceAssessment(group, external, confidence);
    const jiraSource = external.find((source) => source.source === SOURCE_NAMES.jira);
    const acceptedJiraEvidenceIds = new Set((jiraSource?.relationships || []).filter((item) => item.relationship === 'confirmed').map((item) => item.evidenceId));
    const confirmedJiraTypes = (jiraSource?.evidence || [])
      .filter((item) => acceptedJiraEvidenceIds.has(item.id))
      .map((item) => canonical(item.metadata?.issueType));
    const incidentBacked = confirmedJiraTypes.some((value) => value.includes('incident'));
    const problemBacked = confirmedJiraTypes.some((value) => value.includes('problem'));
    const patternLabels = [...new Set([
      ...(group.labels || [group.classification]),
      ...(confidence.score >= 60 ? ['cross_source_evidence'] : []),
      ...(incidentBacked ? ['incident_backed'] : []),
      ...(problemBacked ? ['problem_backed'] : []),
    ])];
    const reviewRisk = assessReviewRisk(group, {
      correlationConfidence: confidence.score,
      incidentBacked,
      problemBacked,
      strongCrossSourceEvidence: confidence.score >= 60,
    });
    let feedback = null;
    try { feedback = await (await getFeedbackStore()).get(id); } catch { feedback = null; }
    const value = {
      groupId: id,
      range,
      readOnly: true,
      phaseOne: {
        classification: group.classification,
        labels: group.labels || [group.classification],
        noiseLikelihood: group.noiseLikelihood ?? group.noiseScore,
        noiseScore: group.noiseScore,
        oldNoiseScore: group.oldNoiseScore ?? null,
        primaryClassification: group.primaryClassification || group.classification,
        recommendation: group.recommendation,
      },
      correlationWindowMinutes: config.correlationWindowMinutes,
      windows,
      confidence,
      patternLabels,
      reviewRisk,
      refinedRecommendation: refinedRecommendation(group, confidence, assessment, reviewRisk),
      supportingEvidence: assessment.supporting,
      contradictingEvidence: assessment.contradicting,
      sources,
      timeline: evidenceTimeline(sources),
      feedback,
      executionTimeMs: Math.max(0, now() - startedAt),
      cache: { hit: false, ttlMs: config.cacheTtlMs },
      externalMutations: 'none',
      sourceIdentity: options.sourceIdentity ? { entityId: options.sourceIdentity.canonicalEntity?.entityId, applied: true } : { applied: false },
      evidencePipeline: useSharedAdapters ? 'SHARED_SOURCE_ADAPTERS_V1' : 'LEGACY_COMPATIBILITY',
    };
    cache.set(cacheKey, { cachedAtMs: now(), value });
    return value;
  }

  async function saveFeedback(groupId, value) {
    const id = String(groupId || '').trim();
    const feedback = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    if (!FEEDBACK_VALUES.has(feedback)) throw safeError('feedback must be correlation_correct or correlation_incorrect.', 'INVALID_CORRELATION_FEEDBACK');
    const saved = await (await getFeedbackStore()).save(id, feedback);
    for (const cached of cache.values()) if (cached.value.groupId === id) cached.value.feedback = saved;
    return { ...saved, localOnly: true, externalMutations: 'none' };
  }

  return { getEvidence, saveFeedback };
}

module.exports = {
  balancedEvidenceSample,
  buildWindows,
  collectJira,
  confidenceForScore,
  correlationSummary,
  createNoiseEvidenceService,
  groupIdentity,
  mapWithConcurrency,
  normalizeEvidence,
  operationsSummary,
  refinedRecommendation,
  withSourceTimeout,
  service: createNoiseEvidenceService(),
};
