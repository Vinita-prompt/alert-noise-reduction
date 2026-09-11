const crypto = require('crypto');
const db = require('../config/db');
const { SOURCE_IDENTITY_CONFIG } = require('../config/sourceIdentity');
const { service: alertFoundationService } = require('./alertFoundation.service');
const accJiraReadService = require('./atlassian/accJiraRead.service');
const appDynamicsService = require('./appDynamics.service');
const {
  canonicalSource,
  service: sourceSideIdentityDiscoveryService,
} = require('./sourceSideIdentityDiscovery.service');
const {
  EXTRACTED_FIELDS,
  extractRawOperationsIdentity,
  summarizeExtractions,
} = require('./rawOperationsIdentity.service');

const ENTITY_TYPES = new Set([
  'APPLICATION',
  'SERVICE',
  'HOST',
  'DATABASE',
  'API',
  'BUSINESS_TRANSACTION',
  'QUEUE',
  'ENDPOINT',
  'SYNTHETIC_TEST',
  'INFRASTRUCTURE_COMPONENT',
  'UNKNOWN',
]);
const MAPPING_LEVELS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL', 'CANDIDATE', 'CONFLICT', 'UNKNOWN', 'STALE']);
const ACCEPTED_VALIDATION_LEVELS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const REVIEWABLE_LEVELS = new Set(['STRONG', 'CANDIDATE']);
const SOURCE_KEYS = Object.freeze({
  appDynamics: 'AppDynamics',
  grafana: 'Grafana',
  thousandEyes: 'ThousandEyes',
  nagios: 'Nagios',
  jira: 'ACC Jira',
});
const GENERIC_NAMES = new Set([
  'cpu', 'cpu-usage', 'memory', 'memory-usage', 'errors', 'error', 'error-rate',
  'errors-per-minute', 'latency', 'availability', 'status', 'health', 'alert',
  'kubernetes', 'plt',
]);
const GENERIC_TOKENS = new Set(['alert', 'application', 'service', 'prod', 'production', 'qa', 'test', 'dev', 'dc01', 'dc02']);

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

function normalizeIdentity(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined).map(cleanText).filter(Boolean))];
}

function isOpaqueIdentifier(value) {
  const normalized = cleanText(value);
  return /^[a-f0-9]{32,}$/i.test(normalized)
    || /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(normalized)
    || /^[a-f0-9-]{20,}-\d{10,}$/i.test(normalized);
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stableId(...values) {
  return crypto.createHash('sha256').update(values.map((value) => String(value || '')).join('|')).digest('hex').slice(0, 24);
}

function environmentFromText(value) {
  const normalized = normalizeIdentity(value);
  if (!normalized) return null;
  if (/(^|[-.:/])(dc0?1|d0?1)([-.:/]|$)/.test(normalized)) return 'dc01';
  if (/(^|[-.:/])(dc0?2|d0?2)([-.:/]|$)/.test(normalized)) return 'dc02';
  if (/(^|[-.:/])(prod|production)([-.:/]|$)/.test(normalized)) return 'production';
  if (/(^|[-.:/])(qa|quality)([-.:/]|$)/.test(normalized)) return 'qa';
  if (/(^|[-.:/])(stage|staging|stg)([-.:/]|$)/.test(normalized)) return 'staging';
  if (/(^|[-.:/])(dev|development)([-.:/]|$)/.test(normalized)) return 'development';
  if (/(^|[-.:/])(test|testing)([-.:/]|$)/.test(normalized)) return 'test';
  return null;
}

function normalizeEnvironment(value) {
  return environmentFromText(value) || normalizeIdentity(value) || null;
}

function environmentDomain(value) {
  const normalized = normalizeEnvironment(value);
  if (!normalized) return null;
  if (['dc01', 'dc02'].includes(normalized)) return 'SITE';
  if (['production', 'qa', 'staging', 'development', 'test'].includes(normalized)) return 'DEPLOYMENT';
  return 'OTHER';
}

function valuesForKeys(value, pattern, depth = 0, output = []) {
  if (!value || depth > 6 || output.length >= 80) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => valuesForKeys(item, pattern, depth + 1, output));
    return output;
  }
  if (typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, item]) => {
    if (pattern.test(key) && ['string', 'number'].includes(typeof item) && cleanText(item)) {
      output.push({ key, value: cleanText(item) });
    }
    if (item && typeof item === 'object') valuesForKeys(item, pattern, depth + 1, output);
  });
  return output;
}

function stringValues(value, depth = 0, output = []) {
  if (value === null || value === undefined || depth > 7 || output.length >= 160) return output;
  if (typeof value === 'string') {
    if (cleanText(value)) output.push(cleanText(value));
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => stringValues(item, depth + 1, output));
    return output;
  }
  if (typeof value === 'object') Object.values(value).forEach((item) => stringValues(item, depth + 1, output));
  return output;
}

function extractDeepLinkIdentity(values = []) {
  const links = unique(values.flatMap((value) => stringValues(value)).filter((value) => /https?:\/\//i.test(value)));
  const result = {
    links,
    appDynamicsIds: [], appDynamicsApplicationIds: [], appDynamicsNodeIds: [], appDynamicsTierIds: [],
    appDynamicsBusinessTransactionIds: [], appDynamicsEventIds: [],
    grafanaRuleUids: [], grafanaDashboardUids: [], grafanaPanelIds: [],
    nagiosHosts: [], nagiosServices: [], nagiosSites: [],
    thousandEyesTestIds: [], thousandEyesAlertIds: [],
  };
  const collect = (key, value) => { if (cleanText(value)) result[key].push(cleanText(value)); };
  links.forEach((link) => {
    let decoded = link;
    try { decoded = decodeURIComponent(link); } catch { /* Preserve the original link when percent encoding is malformed. */ }
    const queryValue = (names) => {
      for (const name of names) {
        const match = decoded.match(new RegExp(`[?&#;/](?:${name})=([^&#/\\s]+)`, 'i'));
        if (match) return match[1];
      }
      return null;
    };
    if (/appdynamics/i.test(decoded)) {
      const applicationId = queryValue(['application', 'applicationId', 'application-id']);
      const nodeId = queryValue(['node', 'nodeId', 'node-id']);
      const tierId = queryValue(['tier', 'tierId', 'tier-id']);
      const btId = queryValue(['businessTransaction', 'businessTransactionId', 'btId']);
      const eventId = queryValue(['event', 'eventId', 'eventSummary', 'violation', 'violationId']);
      [applicationId, nodeId, tierId, btId, eventId].forEach((id) => collect('appDynamicsIds', id));
      collect('appDynamicsApplicationIds', applicationId); collect('appDynamicsNodeIds', nodeId);
      collect('appDynamicsTierIds', tierId); collect('appDynamicsBusinessTransactionIds', btId);
      collect('appDynamicsEventIds', eventId);
    }
    if (/grafana/i.test(decoded)) {
      const dashboard = decoded.match(/\/d\/([^/?#]+)/i)?.[1] || queryValue(['dashboardUid', 'dashboard']);
      const rule = decoded.match(/\/alerting\/[^/]*\/([^/?#]+)/i)?.[1] || queryValue(['ruleUid', 'rule']);
      collect('grafanaDashboardUids', dashboard); collect('grafanaRuleUids', rule);
      collect('grafanaPanelIds', queryValue(['viewPanel', 'panelId', 'panel']));
    }
    if (/thousandeyes/i.test(decoded)) {
      collect('thousandEyesTestIds', decoded.match(/\/tests?\/([^/?#]+)/i)?.[1] || queryValue(['testId', 'test']));
      collect('thousandEyesAlertIds', decoded.match(/\/alerts?\/([^/?#]+)/i)?.[1] || queryValue(['alertId', 'alert']));
    }
    if (/nagios/i.test(decoded)) {
      collect('nagiosHosts', queryValue(['host', 'host_name']));
      collect('nagiosServices', queryValue(['service', 'service_description']));
      const site = decoded.match(/\b(dc0?1|dc0?2)\b/i)?.[1];
      collect('nagiosSites', site);
    }
  });
  Object.keys(result).forEach((key) => { if (Array.isArray(result[key])) result[key] = unique(result[key]); });
  return result;
}

function inferEntityType(identity) {
  const combined = normalizeIdentity([identity.canonicalName, ...identity.services, ...identity.applications].join(' '));
  if (identity.hosts.length && !identity.services.length && !identity.applications.length) return 'HOST';
  if (/(^|-)(database|db|postgres|oracle|mysql|sql)(-|$)/.test(combined)) return 'DATABASE';
  if (/(^|-)(queue|kafka|rabbitmq|mq)(-|$)/.test(combined)) return 'QUEUE';
  if (/(^|-)(api|endpoint|url)(-|$)/.test(combined)) return 'API';
  if (identity.businessTransactions.length) return 'BUSINESS_TRANSACTION';
  if (identity.testIds.length) return 'SYNTHETIC_TEST';
  if (identity.services.length) return 'SERVICE';
  if (identity.applications.length) return 'APPLICATION';
  if (identity.hosts.length) return 'HOST';
  return 'UNKNOWN';
}

function sourceNames(group) {
  return unique((group.alerts || []).flatMap((alert) => [alert.sourceSystem, alert.source, alert.integration]).concat(group.sources || []));
}

function sourceIdentityGroups(analysis = {}) {
  const groups = [...(analysis.groups || [])];
  const normalizedAlerts = analysis._normalizedAlerts || [];
  if (!normalizedAlerts.length) return groups;
  const groupedIds = new Set(groups.flatMap((group) => (group.alerts || []).map((alert) => String(alert.id || alert.canonicalOperationsId || ''))).filter(Boolean));
  const buckets = new Map();
  normalizedAlerts.filter((alert) => {
    const id = String(alert.id || alert.canonicalOperationsId || '');
    return id && !groupedIds.has(id);
  }).forEach((alert) => {
    const source = canonicalSource(alert.sourceSystem || alert.source || alert.integration?.name || alert.integration);
    const fingerprint = cleanText(alert.fingerprintData?.fingerprintHash || alert.title || alert.message || alert.id);
    const key = `${source}:${fingerprint}`;
    const bucket = buckets.get(key) || [];
    bucket.push(alert);
    buckets.set(key, bucket);
  });
  buckets.forEach((alerts, key) => {
    const source = canonicalSource(alerts[0]?.sourceSystem || alerts[0]?.source || alerts[0]?.integration?.name || alerts[0]?.integration);
    const timestamps = alerts.map((alert) => alert.createdAt).filter(Boolean).sort();
    groups.push({
      groupId: stableId('phase5f-source-identity', key),
      pattern: cleanText(alerts[0]?.title || alerts[0]?.message || key),
      firstSeen: timestamps[0] || null,
      lastSeen: timestamps.at(-1) || null,
      sources: [source],
      alerts,
      sourceIdentitySyntheticGroup: true,
    });
  });
  return groups;
}

function mergeRawExtractions(alerts = []) {
  const items = alerts.map((alert) => alert.identityExtractionMetadata || extractRawOperationsIdentity(
    alert.rawPayload || alert.rawOperationsPayload || alert,
    { alertId: alert.id, source: alert.sourceSystem || alert.source },
  ));
  const extracted = Object.fromEntries(EXTRACTED_FIELDS.map((field) => [
    field,
    unique(items.flatMap((item) => item?.extracted?.[field] || [])),
  ]));
  const provenance = items.flatMap((item) => item?.provenance || []).filter((entry, index, values) => (
    values.findIndex((candidate) => candidate.field === entry.field
      && candidate.value === entry.value && candidate.source === entry.source) === index
  ));
  const conflicts = items.flatMap((item) => (item?.conflicts || []).map((conflict) => ({
    ...conflict,
    alertId: item.alertId,
    source: item.source,
  })));
  return {
    items,
    extracted,
    provenance,
    conflicts,
    summary: summarizeExtractions(items),
    fieldsSearched: unique(items.flatMap((item) => item?.fieldsSearched || [])),
    fieldsFound: unique(items.flatMap((item) => item?.fieldsFound || [])),
    fieldsMissing: unique(items.flatMap((item) => item?.fieldsMissing || [])),
  };
}

function extractOperationsIdentity(group, now = () => Date.now()) {
  const alerts = group.alerts || [];
  const rawExtraction = mergeRawExtractions(alerts);
  const raw = rawExtraction.extracted;
  const rawFrom = (field, type) => unique(rawExtraction.provenance
    .filter((entry) => entry.field === field && entry.provenanceType === type)
    .map((entry) => entry.value));
  const structured = alerts.flatMap((alert) => [alert, alert.sourceDetails, alert.sourceIdentifiers, alert.extraProperties]).filter(Boolean);
  const deepLinks = extractDeepLinkIdentity(structured);
  const applications = unique(alerts.flatMap((alert) => [
    alert.application,
    ...valuesForKeys(alert.sourceDetails, /^(application|applicationName|appName)$/i).map((item) => item.value),
    ...valuesForKeys(alert.sourceIdentifiers, /application/i).map((item) => item.value),
    ...valuesForKeys(alert.extraProperties, /^(application|applicationName|appName)$/i).map((item) => item.value),
  ]).concat(raw.applicationNames));
  const services = unique(alerts.flatMap((alert) => [
    alert.service,
    ...valuesForKeys(alert.sourceDetails, /^(service|serviceName)$/i).map((item) => item.value),
    ...valuesForKeys(alert.sourceIdentifiers, /service/i).map((item) => item.value),
    ...valuesForKeys(alert.extraProperties, /^(service|serviceName)$/i).map((item) => item.value),
  ]).concat(raw.serviceNames));
  const businessTransactions = unique(structured.flatMap((value) => valuesForKeys(value, /business.?transaction/i).map((item) => item.value)).concat(raw.businessTransactionNames));
  const hosts = unique(alerts.flatMap((alert) => [
    alert.host,
    alert.hostname,
    alert.sourceDetails?.host,
    alert.sourceDetails?.hostname,
    ...valuesForKeys(alert.sourceIdentifiers, /^(host|hostname|hostName)$/i).map((item) => item.value),
    ...valuesForKeys(alert.extraProperties, /^(host|hostname|hostName)$/i).map((item) => item.value),
  ]).concat(deepLinks.nagiosHosts, raw.hostNames));
  const environments = unique(alerts.flatMap((alert) => [
    alert.environment,
    ...valuesForKeys(alert.sourceDetails, /^(environment|env)$/i).map((item) => item.value),
    ...valuesForKeys(alert.extraProperties, /^(environment|env)$/i).map((item) => item.value),
  ]).concat(deepLinks.nagiosSites, raw.environmentNames));
  const keyed = structured.flatMap((value) => valuesForKeys(value, /(application.?id|dashboard.?uid|panel.?id|rule.?uid|rule.?id|test.?id|agent.?id|event.?id|source.?(?:id|identifier)|alert.?id)/i));
  const idsFor = (pattern) => unique(keyed.filter((item) => pattern.test(item.key)).map((item) => item.value));
  const alertNumbers = unique(alerts.flatMap((alert) => [alert.tinyId, alert.alertNumber]));
  const operationsIds = unique(alerts.flatMap((alert) => [alert.id, alert.canonicalOperationsId]));
  const jiraKeys = unique(alerts.flatMap((alert) => [alert.title, alert.message, alert.description].flatMap((value) => cleanText(value).match(/\bACC-\d+\b/gi) || [])).map((value) => value.toUpperCase()));
  const rules = unique(structured.flatMap((value) => valuesForKeys(value, /(alert.?rule|rule.?name|health.?rule)/i).map((item) => item.value))
    .concat(raw.ruleNames, raw.healthRuleNames));
  const aliases = unique(alerts.map((alert) => alert.alias));
  const sourceIds = unique([...keyed.map((item) => item.value), ...aliases, ...deepLinks.thousandEyesAlertIds, ...raw.sourceEntityIds]);
  const nagiosParts = originMatches({ sources: sourceNames(group) }, 'Nagios') ? unique([...aliases, ...sourceIds]).map((value) => {
    const separator = value.indexOf('_');
    if (separator > 0) return { host: value.slice(0, separator), service: value.slice(separator + 1) };
    return /[.]/.test(value) ? { host: value, service: null } : null;
  }).filter(Boolean) : [];
  hosts.push(...unique(nagiosParts.map((item) => item.host)).filter((value) => !hosts.some((host) => normalizeIdentity(host) === normalizeIdentity(value))));
  services.push(...unique(nagiosParts.map((item) => item.service)).filter((value) => !services.some((service) => normalizeIdentity(service) === normalizeIdentity(value))));
  const humanAliases = aliases.filter((value) => !isOpaqueIdentifier(value));
  const structuredNames = unique([...services, ...applications, ...businessTransactions, ...hosts, ...humanAliases]);
  const fallback = cleanText(group.pattern).replace(/^\[[^\]]+\]\s*:?-?\s*/g, '').split(/\s+(?:is|has|was|detected)\b/i)[0];
  const canonicalName = structuredNames[0] || cleanText(fallback) || `operations-pattern-${group.groupId || 'unknown'}`;
  const environment = normalizeEnvironment(environments[0]) || structuredNames.map(environmentFromText).find(Boolean) || null;
  const base = {
    canonicalName,
    applications,
    services,
    businessTransactions,
    hosts,
    environments,
    environment,
    aliases,
    sourceIds,
    alertNumbers,
    operationsIds,
    jiraKeys,
    rules,
    appDynamicsIds: unique([...idsFor(/application.?id|node.?id|tier.?id|health.?rule.?id/i), ...deepLinks.appDynamicsIds,
      ...raw.applicationIds, ...raw.nodeIds, ...raw.tierIds, ...raw.businessTransactionIds,
      ...raw.healthRuleIds, ...raw.policyIds, ...raw.eventIds, ...raw.violationIds]),
    appDynamicsApplicationIds: unique([...deepLinks.appDynamicsApplicationIds, ...raw.applicationIds]),
    appDynamicsNodeIds: unique([...deepLinks.appDynamicsNodeIds, ...raw.nodeIds]),
    appDynamicsTierIds: unique([...deepLinks.appDynamicsTierIds, ...raw.tierIds]),
    appDynamicsBusinessTransactionIds: unique([...deepLinks.appDynamicsBusinessTransactionIds, ...raw.businessTransactionIds]),
    appDynamicsHealthRuleIds: raw.healthRuleIds,
    appDynamicsPolicyIds: raw.policyIds,
    appDynamicsEventIds: unique([...deepLinks.appDynamicsEventIds, ...raw.eventIds]),
    appDynamicsViolationIds: raw.violationIds,
    grafanaRuleUids: unique([...idsFor(/rule.?uid/i), ...deepLinks.grafanaRuleUids, ...raw.ruleUids]),
    grafanaDashboardUids: unique([...idsFor(/dashboard.?uid/i), ...deepLinks.grafanaDashboardUids, ...raw.dashboardUids]),
    grafanaPanelIds: unique([...idsFor(/panel.?id/i), ...deepLinks.grafanaPanelIds, ...raw.panelIds]),
    grafanaDatasourceIds: raw.datasourceIds,
    testIds: unique([...idsFor(/test.?id/i), ...deepLinks.thousandEyesTestIds, ...raw.testIds]),
    agentIds: unique([...idsFor(/agent.?id/i), ...raw.agents]),
    deepLinks: {
      ...deepLinks,
      links: unique([...deepLinks.links, ...raw.deepLinks]),
      appDynamicsIds: unique([...deepLinks.appDynamicsIds, ...rawFrom('applicationIds', 'DEEP_LINK'),
        ...rawFrom('nodeIds', 'DEEP_LINK'), ...rawFrom('tierIds', 'DEEP_LINK'),
        ...rawFrom('businessTransactionIds', 'DEEP_LINK'), ...rawFrom('healthRuleIds', 'DEEP_LINK'),
        ...rawFrom('eventIds', 'DEEP_LINK'), ...rawFrom('violationIds', 'DEEP_LINK')]),
      appDynamicsApplicationIds: unique([...deepLinks.appDynamicsApplicationIds, ...rawFrom('applicationIds', 'DEEP_LINK')]),
      appDynamicsNodeIds: unique([...deepLinks.appDynamicsNodeIds, ...rawFrom('nodeIds', 'DEEP_LINK')]),
      appDynamicsTierIds: unique([...deepLinks.appDynamicsTierIds, ...rawFrom('tierIds', 'DEEP_LINK')]),
      appDynamicsBusinessTransactionIds: unique([...deepLinks.appDynamicsBusinessTransactionIds, ...rawFrom('businessTransactionIds', 'DEEP_LINK')]),
      appDynamicsEventIds: unique([...deepLinks.appDynamicsEventIds, ...rawFrom('eventIds', 'DEEP_LINK')]),
      grafanaRuleUids: unique([...deepLinks.grafanaRuleUids, ...rawFrom('ruleUids', 'DEEP_LINK')]),
      grafanaDashboardUids: unique([...deepLinks.grafanaDashboardUids, ...rawFrom('dashboardUids', 'DEEP_LINK')]),
      grafanaPanelIds: unique([...deepLinks.grafanaPanelIds, ...rawFrom('panelIds', 'DEEP_LINK')]),
      nagiosHosts: unique([...deepLinks.nagiosHosts, ...rawFrom('hostNames', 'DEEP_LINK')]),
      nagiosServices: unique([...deepLinks.nagiosServices, ...rawFrom('serviceNames', 'DEEP_LINK')]),
      nagiosSites: unique([...deepLinks.nagiosSites, ...rawFrom('environmentNames', 'DEEP_LINK')]),
      thousandEyesTestIds: unique([...deepLinks.thousandEyesTestIds, ...rawFrom('testIds', 'DEEP_LINK')]),
      thousandEyesAlertIds: unique([...deepLinks.thousandEyesAlertIds, ...rawFrom('sourceEntityIds', 'DEEP_LINK')]),
    },
    rawExtraction,
    sources: sourceNames(group),
    firstSeen: toIso(group.firstSeen || alerts.map((alert) => alert.createdAt).filter(Boolean).sort()[0]),
    lastSeen: toIso(group.lastSeen || alerts.map((alert) => alert.createdAt).filter(Boolean).sort().at(-1)),
  };
  const entityType = inferEntityType(base);
  const entityId = stableId(normalizeIdentity(canonicalName), environment || 'unknown', entityType);
  const deterministicAliases = unique(structuredNames.filter((name) => normalizeIdentity(name) === normalizeIdentity(canonicalName) && name !== canonicalName)).map((alias) => ({
    alias,
    source: 'JSM Operations',
    reason: 'Structured Operations fields normalize to the canonical identifier.',
    confidence: 'EXACT',
    createdAt: new Date(now()).toISOString(),
    manual: false,
  }));
  return { ...base, entityId, entityType, deterministicAliases };
}

function environmentCompatible(left, right) {
  const a = normalizeEnvironment(left);
  const b = normalizeEnvironment(right);
  return !a || !b || a === b;
}

function nameCandidates(identity) {
  return unique([identity.canonicalName, ...identity.services, ...identity.applications, ...identity.businessTransactions, ...identity.aliases]);
}

function exactName(value, identity) {
  const normalized = normalizeIdentity(value);
  return Boolean(normalized && nameCandidates(identity).some((candidate) => normalizeIdentity(candidate) === normalized));
}

function partialName(value, identity) {
  const normalized = normalizeIdentity(value);
  if (!normalized || GENERIC_NAMES.has(normalized) || normalized.length < 5) return null;
  const candidates = nameCandidates(identity).map(normalizeIdentity).filter((candidate) => candidate.length >= 5 && !GENERIC_NAMES.has(candidate));
  return candidates.find((candidate) => {
    if (candidate === normalized) return false;
    const shorter = candidate.length < normalized.length ? candidate : normalized;
    const longer = candidate.length < normalized.length ? normalized : candidate;
    const tokens = shorter.split('-').filter((token) => token.length >= 3);
    return shorter.length >= 8 && longer.includes(shorter) && (tokens.length >= 2 || shorter.length >= 12);
  }) || null;
}

function originMatches(identity, source) {
  const target = normalizeIdentity(source).replace('dynamics', 'd');
  return identity.sources.some((value) => {
    const normalized = normalizeIdentity(value).replace('dynamics', 'd');
    return normalized.includes(target) || target.includes(normalized);
  });
}

function rawEvidenceForValue(identity, value, fields = []) {
  const expected = cleanText(value);
  return (identity.rawExtraction?.provenance || []).filter((entry) => (
    expected && cleanText(entry.value) === expected && (!fields.length || fields.includes(entry.field))
  ));
}

function rawIdentitySource(evidence = [], fallback = 'STRUCTURED_METADATA') {
  if (evidence.some((entry) => entry.provenanceType === 'DEEP_LINK')) return 'DEEP_LINK';
  if (evidence.some((entry) => entry.provenanceType === 'LABEL')) return 'LABEL';
  if (evidence.some((entry) => entry.provenanceType === 'TAG')) return 'TAG';
  if (evidence.some((entry) => entry.provenanceType === 'ANNOTATION')) return 'ANNOTATION';
  if (evidence.some((entry) => entry.provenanceType === 'SOURCE_METADATA')) return 'SOURCE_METADATA';
  if (evidence.length) return 'RAW_PAYLOAD';
  return fallback;
}

function mappingRecord(source, item, level, score, reasons, extra = {}) {
  return {
    source,
    sourceEntityId: cleanText(item.sourceEntityId || item.id),
    sourceEntityName: cleanText(item.sourceEntityName || item.name) || null,
    sourceEntityType: item.sourceEntityType || item.kind || null,
    environment: normalizeEnvironment(item.environment) || null,
    level,
    mappingState: level,
    evidenceLevel: level,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: unique(reasons),
    status: 'AUTOMATIC',
    mappingMechanism: extra.mappingMechanism || 'deterministic_inventory_match',
    provenance: {
      automatic: true,
      manual: false,
      sourceSystem: source,
      createdAt: extra.createdAt || null,
      lastValidatedAt: extra.lastValidatedAt || null,
      identityEvidence: extra.identityEvidence || [],
    },
    metadata: {
      ...(source === 'AppDynamics' ? {
        applicationId: item.applicationId || (item.sourceEntityType === 'APPLICATION' || item.kind === 'application' ? item.id : null),
        host: item.host || null,
        tierName: item.tierName || null,
      } : {}),
      ...(extra.metadata || {}),
    },
    identitySource: extra.identitySource || (reasons.some((reason) => /deep link/i.test(reason)) ? 'DEEP_LINK' : 'STRUCTURED_METADATA'),
    resolution: extra.resolution || null,
    usableForSourceValidation: ACCEPTED_VALIDATION_LEVELS.has(level),
  };
}

function mappingFromDiscovery(result) {
  if (!result || !ACCEPTED_VALIDATION_LEVELS.has(result.discoveryState)) return null;
  const identity = result.sourceSpecificIdentity || {};
  return mappingRecord(result.source, {
    id: result.entityId,
    name: result.entityName,
    kind: result.entityType,
    sourceEntityType: result.entityType,
    environment: identity.environment || identity.site || null,
    applicationId: identity.applicationId || null,
    host: identity.host || identity.node || null,
    tierName: identity.tierName || null,
  }, result.discoveryState, result.discoveryState === 'EXACT' ? 100 : 90, [
    ...(result.evidenceUsed || []),
    result.reasoning,
  ], {
    mappingMechanism: 'source_side_inventory_discovery',
    identitySource: 'SOURCE_INVENTORY',
    identityEvidence: (result.matchingAttributes || []).map((item) => ({
      value: item.operationsValue,
      field: item.field,
      source: `sourceCatalog.${result.source}`,
      provenanceType: 'SOURCE_METADATA',
    })),
    metadata: {
      ...identity,
      discoveryPatternKey: result.patternKey,
      inventoryVersion: result.inventoryVersion,
      matchingAttributes: result.matchingAttributes || [],
      rejectedCandidates: result.candidates || [],
    },
  });
}

function stripEnvironmentPrefix(value) {
  const normalized = normalizeIdentity(value);
  return normalized.replace(/^(?:prod|production|qa|quality|stage|staging|stg|dev|development|test|testing)-/, '');
}

function dedupeMappings(items, limit = 3) {
  const ordered = [...items].sort((left, right) => right.score - left.score || left.sourceEntityName?.localeCompare(right.sourceEntityName || '') || 0);
  const seen = new Set();
  return ordered.filter((item) => {
    const key = `${item.source}|${item.sourceEntityType}|${item.sourceEntityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function addLookup(map, rawKey, item) {
  const key = normalizeIdentity(rawKey);
  if (!key) return;
  const bucket = map.get(key) || [];
  bucket.push(item);
  map.set(key, bucket);
}

function inventoryNames(item) {
  return unique([
    item.name,
    item.host,
    item.service,
    item.dashboardTitle,
    item.panelTitle,
    item.ruleTitle,
    item.labels?.service,
    item.labels?.application,
    item.annotations?.service,
    item.annotations?.application,
  ]);
}

function buildLookup(items = []) {
  const byId = new Map();
  const byName = new Map();
  const byToken = new Map();
  items.forEach((item) => {
    unique([item.id, item.alertId, item.testId, item.ruleId, item.dashboardUid, item.panelId, ...(item.agentIds || [])]).forEach((id) => addLookup(byId, id, item));
    inventoryNames(item).forEach((name) => {
      addLookup(byName, name, item);
      normalizeIdentity(name).split('-').filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token)).forEach((token) => addLookup(byToken, token, item));
    });
  });
  return { items, byId, byName, byToken };
}

function indexedCandidates(inventory, ids = [], names = []) {
  if (Array.isArray(inventory)) return inventory;
  if (!inventory?.items) return [];
  const candidates = new Set();
  unique(ids).forEach((id) => (inventory.byId.get(normalizeIdentity(id)) || []).forEach((item) => candidates.add(item)));
  unique(names).forEach((name) => {
    (inventory.byName.get(normalizeIdentity(name)) || []).forEach((item) => candidates.add(item));
    normalizeIdentity(name).split('-').filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token)).forEach((token) => (
      inventory.byToken.get(token) || []
    ).forEach((item) => candidates.add(item)));
  });
  return [...candidates];
}

function prepareInventories(value) {
  return {
    ...value,
    appDynamics: buildLookup(value.appDynamics || []),
    grafana: buildLookup(value.grafana || []),
    thousandEyes: buildLookup(value.thousandEyes || []),
    nagios: buildLookup(value.nagios || []),
    jira: value.jira || [],
  };
}

function appDynamicsMappings(identity, inventory, config) {
  const mappings = [];
  for (const item of indexedCandidates(inventory, identity.appDynamicsIds, nameCandidates(identity))) {
    const env = item.environment || environmentFromText([item.name, ...(item.tags || [])].join(' '));
    if (!environmentCompatible(identity.environment, env)) continue;
    if (identity.appDynamicsIds.includes(String(item.id))) {
      const fromDeepLink = identity.deepLinks?.appDynamicsIds?.includes(String(item.id));
      const rawEvidence = rawEvidenceForValue(identity, item.id, ['applicationIds', 'tierIds', 'nodeIds',
        'businessTransactionIds', 'healthRuleIds', 'policyIds', 'eventIds', 'violationIds']);
      mappings.push(mappingRecord('AppDynamics', item, 'EXACT', 100, [
        `Exact AppDynamics ${item.kind || 'entity'} ID ${item.id}`,
        fromDeepLink ? 'Identifier was parsed from an Operations source deep link'
          : rawEvidence.length ? `Identifier was extracted from original Operations field ${rawEvidence[0].source}`
            : 'Identifier came from structured Operations metadata',
        'Identifier was validated against current AppDynamics inventory',
      ], { identitySource: fromDeepLink ? 'DEEP_LINK' : rawIdentitySource(rawEvidence), identityEvidence: rawEvidence }));
      continue;
    }
    if (item.kind === 'node' && identity.hosts.some((host) => normalizeIdentity(host) === normalizeIdentity(item.host || item.name))) {
      mappings.push(mappingRecord('AppDynamics', item, 'STRONG', 88, [`Exact node host/name match: ${item.host || item.name}`, env ? `Environment matches ${env}` : 'No conflicting environment identifier']));
      continue;
    }
    if (exactName(item.name, identity)) {
      const exactOrigin = originMatches(identity, 'AppDynamics');
      mappings.push(mappingRecord('AppDynamics', item, exactOrigin && item.kind === 'application' ? 'EXACT' : 'STRONG', exactOrigin ? 98 : env ? 94 : 90, [
        `Exact normalized ${item.kind || 'entity'} name: ${item.name}`,
        exactOrigin ? 'Operations source is AppDynamics' : env ? `Environment matches ${env}` : 'No conflicting environment identifier',
      ]));
      continue;
    }
    const structuredName = unique([...identity.services, ...identity.applications]).find((value) => (
      normalizeIdentity(value) === stripEnvironmentPrefix(item.name)
    ));
    const itemHasEnvironmentPrefix = stripEnvironmentPrefix(item.name) !== normalizeIdentity(item.name);
    if (item.kind === 'application' && structuredName && itemHasEnvironmentPrefix
      && (originMatches(identity, 'AppDynamics') || (identity.environment && env && environmentCompatible(identity.environment, env)))) {
      const timestamp = new Date().toISOString();
      const evidence = [
        `Structured Operations service/application: ${structuredName}`,
        `Exact AppDynamics inventory application after environment-prefix normalization: ${item.name}`,
        originMatches(identity, 'AppDynamics') ? 'Operations integration/source is AppDynamics' : `Structured environment matches ${env}`,
        env ? `Environment prefix resolves to ${env}` : 'No conflicting environment identifier',
      ];
      mappings.push(mappingRecord('AppDynamics', item, 'STRONG', 89, evidence, {
        resolution: {
          fromState: 'CANDIDATE',
          toState: 'STRONG',
          canonicalEntity: identity.canonicalName,
          sourceEntity: item.name,
          sourceEntityId: String(item.id),
          environment: env || null,
          evidence,
          reason: 'A structured Operations identity exactly matches the AppDynamics application after removing one explicit environment prefix.',
          timestamp,
        },
      }));
      continue;
    }
    const partial = partialName(item.name, identity);
    if (partial) mappings.push(mappingRecord('AppDynamics', item, 'CANDIDATE', 58, [`Partial deterministic name overlap: ${partial}`, 'No exact vendor identifier was available']));
  }
  return dedupeMappings(mappings, config.maxCandidatesPerSource);
}

function grafanaStructuredNames(item) {
  return unique([
    item.name,
    item.dashboardTitle,
    item.panelTitle,
    item.ruleTitle,
    item.labels?.service,
    item.labels?.application,
    item.annotations?.service,
    item.annotations?.application,
  ]);
}

function grafanaMappings(identity, inventory, config) {
  const mappings = [];
  const ids = [...identity.grafanaRuleUids, ...identity.grafanaDashboardUids, ...identity.grafanaPanelIds];
  for (const item of indexedCandidates(inventory, ids, [...identity.rules, ...nameCandidates(identity)])) {
    const env = item.environment || environmentFromText([...grafanaStructuredNames(item), ...(item.tags || [])].join(' '));
    if (!environmentCompatible(identity.environment, env)) continue;
    if (item.kind === 'alert_rule' && identity.grafanaRuleUids.includes(String(item.id))) {
      const fromDeepLink = identity.deepLinks?.grafanaRuleUids?.includes(String(item.id));
      const rawEvidence = rawEvidenceForValue(identity, item.id, ['ruleUids']);
      mappings.push(mappingRecord('Grafana', item, 'EXACT', 100, [
        `Exact Grafana alert rule UID ${item.id}`,
        fromDeepLink ? 'UID was parsed from an Operations source deep link'
          : rawEvidence.length ? `UID was extracted from original Operations field ${rawEvidence[0].source}`
            : 'UID came from structured Operations metadata',
        'UID was validated against current Grafana inventory',
      ], { identitySource: fromDeepLink ? 'DEEP_LINK' : rawIdentitySource(rawEvidence), identityEvidence: rawEvidence,
        metadata: { dashboardUid: item.dashboardUid || null, panelId: item.panelId || null } }));
      continue;
    }
    if (item.kind === 'panel' && identity.grafanaDashboardUids.includes(String(item.dashboardUid)) && identity.grafanaPanelIds.includes(String(item.panelId || item.id))) {
      const rawEvidence = [...rawEvidenceForValue(identity, item.dashboardUid, ['dashboardUids']),
        ...rawEvidenceForValue(identity, item.panelId || item.id, ['panelIds'])];
      mappings.push(mappingRecord('Grafana', item, 'EXACT', 100, [`Exact dashboard UID ${item.dashboardUid}`, `Exact panel ID ${item.panelId || item.id}`, 'Dashboard/panel relationship was validated against current Grafana inventory'], {
        identitySource: rawIdentitySource(rawEvidence), identityEvidence: rawEvidence,
        metadata: { dashboardUid: item.dashboardUid, panelId: item.panelId || item.id },
      }));
      continue;
    }
    if (item.kind === 'dashboard' && identity.grafanaDashboardUids.includes(String(item.id))) {
      mappings.push(mappingRecord('Grafana', item, 'STRONG', 92, [`Exact dashboard UID ${item.id}`, 'A panel identifier was not available'], { metadata: { dashboardUid: item.id, panelId: null } }));
      continue;
    }
    const exactStructured = grafanaStructuredNames(item).find((name) => exactName(name, identity));
    if (exactStructured && !(GENERIC_NAMES.has(normalizeIdentity(exactStructured)) && item.kind !== 'alert_rule')) {
      const exactRule = item.kind === 'alert_rule' && identity.rules.some((rule) => normalizeIdentity(rule) === normalizeIdentity(item.name));
      mappings.push(mappingRecord('Grafana', item, exactRule ? 'EXACT' : 'STRONG', exactRule ? 96 : 86, [
        exactRule ? `Exact Grafana alert rule title: ${item.name}` : `Exact structured service/application label: ${exactStructured}`,
        env ? `Environment matches ${env}` : 'No conflicting environment identifier',
      ], { metadata: { dashboardUid: item.dashboardUid || (item.kind === 'dashboard' ? item.id : null), panelId: item.panelId || null } }));
      continue;
    }
    const partial = grafanaStructuredNames(item).map((name) => partialName(name, identity)).find(Boolean);
    if (partial && !GENERIC_NAMES.has(normalizeIdentity(item.name))) mappings.push(mappingRecord('Grafana', item, 'CANDIDATE', 55, [`Partial deterministic metadata overlap: ${partial}`, 'No Grafana UID or exact structured label was available']));
  }
  return dedupeMappings(mappings, config.maxCandidatesPerSource);
}

function thousandEyesMappings(identity, inventory, config) {
  const mappings = [];
  const ids = new Set([...identity.sourceIds, ...identity.testIds, ...identity.agentIds].map(String));
  for (const item of indexedCandidates(inventory, [...ids], nameCandidates(identity))) {
    const itemIds = unique([item.id, item.alertId, item.testId, item.ruleId, ...(item.agentIds || [])]);
    const matchedId = itemIds.find((id) => ids.has(String(id)));
    if (matchedId) {
      const rawEvidence = rawEvidenceForValue(identity, matchedId, ['sourceEntityIds', 'testIds', 'agents']);
      mappings.push(mappingRecord('ThousandEyes', item, 'EXACT', 100, [`Exact ThousandEyes ${item.kind || 'entity'} identifier ${matchedId}`, 'Production v7/source inventory relationship preserved'], {
        identitySource: rawIdentitySource(rawEvidence), identityEvidence: rawEvidence,
        metadata: { alertId: item.alertId || null, testId: item.testId || null, agentIds: item.agentIds || [] },
      }));
      continue;
    }
    if (originMatches(identity, 'ThousandEyes') && exactName(item.name, identity)) {
      mappings.push(mappingRecord('ThousandEyes', item, 'STRONG', 90, [`Exact normalized ThousandEyes test/entity name: ${item.name}`, 'Operations source is ThousandEyes'], { metadata: { testId: item.testId || null, agentIds: item.agentIds || [] } }));
    }
  }
  return dedupeMappings(mappings, config.maxCandidatesPerSource);
}

function nagiosMappings(identity, inventory, config) {
  const mappings = [];
  for (const item of indexedCandidates(inventory, [], [...identity.hosts, ...identity.services])) {
    const instance = normalizeEnvironment(item.instance || item.environment);
    if (identity.environment && ['dc01', 'dc02'].includes(identity.environment) && instance !== identity.environment) continue;
    const hostExact = identity.hosts.some((host) => normalizeIdentity(host) === normalizeIdentity(item.host));
    const serviceExact = item.service && identity.services.some((service) => normalizeIdentity(service) === normalizeIdentity(item.service));
    if (hostExact && serviceExact) {
      mappings.push(mappingRecord('Nagios', item, 'EXACT', 100, [`Exact host match: ${item.host}`, `Exact service match: ${item.service}`, `Environment isolated to ${instance || item.instance}`], { metadata: { host: item.host, service: item.service, instance: item.instance } }));
    } else if (hostExact) {
      const level = identity.environment && instance === identity.environment ? 'STRONG' : 'CANDIDATE';
      mappings.push(mappingRecord('Nagios', item, level, level === 'STRONG' ? 84 : 65, [`Exact host match: ${item.host}`, item.service ? 'Service identity was not confirmed' : 'Host status identity', instance ? `Environment: ${instance}` : 'Environment not available'], { metadata: { host: item.host, service: item.service || null, instance: item.instance } }));
    }
  }
  return dedupeMappings(mappings, config.maxCandidatesPerSource);
}

function containsExactToken(value, token) {
  const haystack = ` ${normalizeIdentity(value).replace(/-/g, ' ')} `;
  const needle = normalizeIdentity(token).replace(/-/g, ' ');
  return needle.length >= 3 && haystack.includes(` ${needle} `);
}

function jiraMappings(identity, inventory, config) {
  const mappings = [];
  for (const issue of inventory || []) {
    const body = [issue.summary, issue.description, issue.resolution, issue.howResolved, ...(issue.comments || [])].filter(Boolean).join(' ');
    const directAlerts = (issue.relatedAlerts || []).flatMap((item) => [item.alertNumber, item.operationsId]).filter(Boolean).map(String);
    const exactAlert = [...identity.alertNumbers, ...identity.operationsIds].find((id) => directAlerts.includes(String(id)) || containsExactToken(body, `Alert #${id}`) || body.includes(String(id)));
    const exactKey = (identity.jiraKeys || []).includes(String(issue.key || '').toUpperCase());
    if (exactAlert || exactKey) {
      mappings.push(mappingRecord('ACC Jira', { id: issue.key, name: issue.summary, kind: issue.issueType }, 'EXACT', 100, [exactAlert ? `Exact Operations alert reference: ${exactAlert}` : `Exact Jira key ${issue.key}`, 'Confirmed relationship policy requires an explicit identifier'], { metadata: { relationship: 'CONFIRMED', status: issue.status || null } }));
      continue;
    }
    const entity = nameCandidates(identity).find((name) => containsExactToken(body, name));
    if (entity) mappings.push(mappingRecord('ACC Jira', { id: issue.key, name: issue.summary, kind: issue.issueType }, 'CANDIDATE', 58, [`Exact entity text reference: ${entity}`, 'No alert ID, source URL, or explicit issue relationship was found'], { metadata: { relationship: 'CANDIDATE', status: issue.status || null } }));
  }
  return dedupeMappings(mappings, config.maxCandidatesPerSource);
}

async function safeRows(sql) {
  try {
    const result = await db.query(sql);
    return { rows: result.rows, available: true, error: null };
  } catch (error) {
    return { rows: [], available: false, error: error.code || 'INVENTORY_UNAVAILABLE' };
  }
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

async function loadSourceInventories() {
  const startedAt = Date.now();
  const [apps, tiers, nodes, transactions, healthRules, dashboards, panels, rules, datasources, nagiosHosts, nagiosServices, thousandEyes] = await Promise.all([
    safeRows('SELECT application_id, application_name, tags, description, updated_at FROM appdynamics_applications'),
    safeRows('SELECT application_id, tier_id, tier_name, updated_at FROM appdynamics_tiers'),
    safeRows('SELECT application_id, node_id, node_name, server_name, tier_name, updated_at FROM appdynamics_nodes'),
    safeRows('SELECT application_id, business_transaction_id, business_transaction_name, tier_name, updated_at FROM appdynamics_business_transactions'),
    safeRows('SELECT application_id, health_rule_id, health_rule_name, updated_at FROM appdynamics_health_rules'),
    safeRows('SELECT uid, title, folder_title, tags, updated_at FROM grafana_dashboards'),
    safeRows('SELECT dashboard_uid, panel_id, panel_title, datasource_name, folder_name, dashboard_title, tags, updated_at FROM grafana_panels'),
    safeRows('SELECT uid, title, dashboard_uid, panel_id, folder_name, labels, annotations, updated_at FROM grafana_alert_rules'),
    safeRows('SELECT uid, name, type, updated_at FROM grafana_datasources'),
    safeRows('SELECT instance_key, host_name, updated_at FROM nagios_host_status WHERE is_active = TRUE'),
    safeRows('SELECT instance_key, host_name, service_description, updated_at FROM nagios_service_status WHERE is_active = TRUE'),
    safeRows("SELECT entity_type, entity_id, application_name, environment, raw_payload, custom_properties, updated_at FROM monitoring_records WHERE LOWER(source_tool) LIKE '%thousand%'")
  ]);
  let liveAppDynamics = { applications: [], available: false, error: null };
  if (!apps.rows.length) {
    try {
      const response = await appDynamicsService.getApplicationIdentityInventory();
      liveAppDynamics = { applications: response.applications || [], available: true, error: null };
    } catch (error) {
      liveAppDynamics = { applications: [], available: false, error: error.code || error.status || 'APPDYNAMICS_INVENTORY_UNAVAILABLE' };
    }
  }
  let jira = { items: [], available: false, error: null };
  try {
    const response = await accJiraReadService.listEvidenceCandidates({ limit: 25 });
    jira = { items: response.items || [], available: true, error: null };
  } catch (error) {
    jira = { items: [], available: false, error: error.code || error.status || 'JIRA_INVENTORY_UNAVAILABLE' };
  }
  const appDynamics = [
    ...apps.rows.map((row) => ({ id: row.application_id, name: row.application_name, kind: 'application', sourceEntityType: 'APPLICATION', tags: jsonArray(row.tags), description: row.description, lastValidatedAt: row.updated_at })),
    ...liveAppDynamics.applications.map((item) => ({ id: item.id, name: item.name, kind: 'application', sourceEntityType: 'APPLICATION', sourceUrl: item.sourceUrl, lastValidatedAt: new Date().toISOString() })),
    ...tiers.rows.map((row) => ({ id: row.tier_id, name: row.tier_name, kind: 'tier', sourceEntityType: 'TIER', applicationId: row.application_id, lastValidatedAt: row.updated_at })),
    ...nodes.rows.map((row) => ({ id: row.node_id, name: row.node_name, host: row.server_name || row.node_name, kind: 'node', sourceEntityType: 'NODE', applicationId: row.application_id, tierName: row.tier_name, lastValidatedAt: row.updated_at })),
    ...transactions.rows.map((row) => ({ id: row.business_transaction_id, name: row.business_transaction_name, kind: 'business_transaction', sourceEntityType: 'BUSINESS_TRANSACTION', applicationId: row.application_id, tierName: row.tier_name, lastValidatedAt: row.updated_at })),
    ...healthRules.rows.map((row) => ({ id: row.health_rule_id, name: row.health_rule_name, kind: 'health_rule', sourceEntityType: 'HEALTH_RULE', applicationId: row.application_id, lastValidatedAt: row.updated_at })),
  ];
  const grafana = [
    ...dashboards.rows.map((row) => ({ id: row.uid, name: row.title, kind: 'dashboard', sourceEntityType: 'DASHBOARD', folder: row.folder_title, tags: jsonArray(row.tags), lastValidatedAt: row.updated_at })),
    ...panels.rows.map((row) => ({ id: `${row.dashboard_uid}:${row.panel_id}`, panelId: row.panel_id, dashboardUid: row.dashboard_uid, name: row.panel_title, panelTitle: row.panel_title, dashboardTitle: row.dashboard_title, kind: 'panel', sourceEntityType: 'PANEL', datasource: row.datasource_name, folder: row.folder_name, tags: jsonArray(row.tags), lastValidatedAt: row.updated_at })),
    ...rules.rows.map((row) => ({ id: row.uid, name: row.title, ruleTitle: row.title, dashboardUid: row.dashboard_uid, panelId: row.panel_id, kind: 'alert_rule', sourceEntityType: 'ALERT_RULE', folder: row.folder_name, labels: row.labels || {}, annotations: row.annotations || {}, lastValidatedAt: row.updated_at })),
    ...datasources.rows.map((row) => ({ id: row.uid, name: row.name, kind: 'datasource', sourceEntityType: 'DATASOURCE', datasourceType: row.type, lastValidatedAt: row.updated_at })),
  ];
  const nagios = [
    ...nagiosHosts.rows.map((row) => ({ id: `${row.instance_key}:${row.host_name}`, name: row.host_name, host: row.host_name, instance: row.instance_key, environment: normalizeEnvironment(row.instance_key), kind: 'host', sourceEntityType: 'HOST', lastValidatedAt: row.updated_at })),
    ...nagiosServices.rows.map((row) => ({ id: `${row.instance_key}:${row.host_name}:${row.service_description}`, name: `${row.host_name} · ${row.service_description}`, host: row.host_name, service: row.service_description, instance: row.instance_key, environment: normalizeEnvironment(row.instance_key), kind: 'service', sourceEntityType: 'SERVICE', lastValidatedAt: row.updated_at })),
  ];
  const thousandEyesInventory = thousandEyes.rows.map((row) => {
    const raw = row.raw_payload || {};
    const custom = row.custom_properties || {};
    return {
      id: row.entity_id,
      name: row.application_name,
      kind: row.entity_type,
      sourceEntityType: String(row.entity_type || 'entity').toUpperCase(),
      environment: row.environment,
      alertId: raw.alertId || raw.id || (row.entity_type === 'alert' ? row.entity_id : null),
      testId: raw.testId || custom.testId || (row.entity_type === 'test' ? row.entity_id : null),
      ruleId: raw.ruleId || custom.ruleId || null,
      agentIds: unique([...(raw.agentIds || []), ...(custom.agentIds || [])]),
      lastValidatedAt: row.updated_at,
    };
  });
  const status = {
    appDynamics: { available: liveAppDynamics.available || [apps, tiers, nodes, transactions, healthRules].some((item) => item.available), records: appDynamics.length, inventorySource: liveAppDynamics.applications.length ? 'live_read_only' : 'stored_metadata' },
    grafana: { available: [dashboards, panels, rules, datasources].some((item) => item.available), records: grafana.length },
    thousandEyes: { available: thousandEyes.available, records: thousandEyesInventory.length },
    nagios: { available: nagiosHosts.available || nagiosServices.available, records: nagios.length },
    jira: { available: jira.available, records: jira.items.length },
  };
  return { appDynamics, grafana, thousandEyes: thousandEyesInventory, nagios, jira: jira.items, status, buildTimeMs: Date.now() - startedAt };
}

async function defaultRegistryStore() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS source_identity_entities (
      entity_id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      environment TEXT,
      aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS source_identity_decisions (
      id BIGSERIAL PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES source_identity_entities(entity_id) ON DELETE CASCADE,
      source_system TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      source_entity_name TEXT,
      source_entity_type TEXT,
      decision TEXT NOT NULL,
      evidence_level TEXT NOT NULL,
      confidence_score INTEGER NOT NULL,
      reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      confirmed_by TEXT,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(entity_id, source_system, source_entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_identity_decisions_entity ON source_identity_decisions(entity_id, source_system);
    CREATE TABLE IF NOT EXISTS source_identity_validated_mappings (
      entity_id TEXT NOT NULL REFERENCES source_identity_entities(entity_id) ON DELETE CASCADE,
      source_system TEXT NOT NULL,
      source_entity_id TEXT NOT NULL,
      source_entity_name TEXT,
      source_entity_type TEXT,
      environment TEXT,
      evidence_level TEXT NOT NULL,
      confidence_score INTEGER NOT NULL,
      reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      mapping_mechanism TEXT NOT NULL,
      identity_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
      resolver_version TEXT,
      validation_status TEXT NOT NULL DEFAULT 'VALID',
      first_validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (entity_id, source_system, source_entity_id)
    );
    ALTER TABLE source_identity_validated_mappings ADD COLUMN IF NOT EXISTS identity_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE source_identity_validated_mappings ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE source_identity_validated_mappings ADD COLUMN IF NOT EXISTS resolver_version TEXT;
    CREATE INDEX IF NOT EXISTS idx_source_identity_validated_entity ON source_identity_validated_mappings(entity_id, source_system, validation_status);
  `);
  const mapRow = (row) => ({
    entityId: row.entity_id,
    source: row.source_system,
    sourceEntityId: row.source_entity_id,
    sourceEntityName: row.source_entity_name,
    sourceEntityType: row.source_entity_type,
    decision: row.decision,
    evidenceLevel: row.evidence_level,
    score: Number(row.confidence_score || 0),
    reasons: row.reasons || [],
    evidence: row.evidence || {},
    confirmedBy: row.confirmed_by || null,
    confirmedAt: row.decided_at,
  });
  const mapValidatedRow = (row) => ({
    entityId: row.entity_id,
    source: row.source_system,
    sourceEntityId: row.source_entity_id,
    sourceEntityName: row.source_entity_name,
    sourceEntityType: row.source_entity_type,
    environment: row.environment,
    evidenceLevel: row.evidence_level,
    score: Number(row.confidence_score || 0),
    reasons: row.reasons || [],
    mappingMechanism: row.mapping_mechanism,
    identityFields: row.identity_fields || {},
    provenance: row.provenance || [],
    resolverVersion: row.resolver_version || null,
    validationStatus: row.validation_status,
    firstValidatedAt: row.first_validated_at,
    lastValidatedAt: row.last_validated_at,
  });
  const saveEntity = (entity) => db.query(`
    INSERT INTO source_identity_entities (entity_id, canonical_name, entity_type, environment, aliases, first_seen, last_seen, updated_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,NOW())
    ON CONFLICT (entity_id) DO UPDATE SET canonical_name=EXCLUDED.canonical_name, entity_type=EXCLUDED.entity_type,
      environment=EXCLUDED.environment, aliases=EXCLUDED.aliases, first_seen=COALESCE(source_identity_entities.first_seen,EXCLUDED.first_seen),
      last_seen=EXCLUDED.last_seen, updated_at=NOW()
  `, [entity.entityId, entity.canonicalName, entity.entityType, entity.environment, JSON.stringify(entity.aliases || []), entity.firstSeen, entity.lastSeen]);
  return {
    async get(entityId) {
      const result = await db.query('SELECT * FROM source_identity_decisions WHERE entity_id = $1', [entityId]);
      return result.rows.map(mapRow);
    },
    async getAll() {
      const result = await db.query('SELECT * FROM source_identity_decisions');
      return result.rows.map(mapRow);
    },
    async getValidated(entityId) {
      const result = await db.query('SELECT * FROM source_identity_validated_mappings WHERE entity_id = $1', [entityId]);
      return result.rows.map(mapValidatedRow);
    },
    async getAllValidated() {
      const result = await db.query('SELECT * FROM source_identity_validated_mappings');
      return result.rows.map(mapValidatedRow);
    },
    async getEntity(entityId) {
      const [entity, decisions] = await Promise.all([
        db.query('SELECT * FROM source_identity_entities WHERE entity_id = $1', [entityId]),
        db.query('SELECT * FROM source_identity_decisions WHERE entity_id = $1', [entityId]),
      ]);
      if (!entity.rows[0]) return null;
      const row = entity.rows[0];
      return { entityId: row.entity_id, canonicalName: row.canonical_name, entityType: row.entity_type, environment: row.environment, aliases: row.aliases || [], firstSeen: row.first_seen, lastSeen: row.last_seen, decisions: decisions.rows.map(mapRow) };
    },
    async save(entity, mapping, decision, actor) {
      await saveEntity(entity);
      const result = await db.query(`
        INSERT INTO source_identity_decisions (entity_id, source_system, source_entity_id, source_entity_name, source_entity_type, decision, evidence_level, confidence_score, reasons, evidence, confirmed_by, decided_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,NOW(),NOW())
        ON CONFLICT (entity_id, source_system, source_entity_id) DO UPDATE SET decision=EXCLUDED.decision, source_entity_name=EXCLUDED.source_entity_name,
          source_entity_type=EXCLUDED.source_entity_type, evidence_level=EXCLUDED.evidence_level, confidence_score=EXCLUDED.confidence_score,
          reasons=EXCLUDED.reasons, evidence=EXCLUDED.evidence, confirmed_by=EXCLUDED.confirmed_by, decided_at=NOW(), updated_at=NOW()
        RETURNING *
      `, [entity.entityId, mapping.source, mapping.sourceEntityId, mapping.sourceEntityName, mapping.sourceEntityType, decision, mapping.evidenceLevel || mapping.level, mapping.score, JSON.stringify(mapping.reasons || []), JSON.stringify({ mappingMechanism: mapping.mappingMechanism, provenance: mapping.provenance }), actor || null]);
      return mapRow(result.rows[0]);
    },
    async saveValidated(entity, mapping, status = 'VALID') {
      await saveEntity(entity);
      const result = await db.query(`
        INSERT INTO source_identity_validated_mappings (
          entity_id, source_system, source_entity_id, source_entity_name, source_entity_type,
          environment, evidence_level, confidence_score, reasons, mapping_mechanism,
          identity_fields, provenance, resolver_version, validation_status,
          first_validated_at, last_validated_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14,NOW(),NOW(),NOW())
        ON CONFLICT (entity_id, source_system, source_entity_id) DO UPDATE SET
          source_entity_name=EXCLUDED.source_entity_name, source_entity_type=EXCLUDED.source_entity_type,
          environment=EXCLUDED.environment, evidence_level=EXCLUDED.evidence_level,
          confidence_score=EXCLUDED.confidence_score, reasons=EXCLUDED.reasons,
          mapping_mechanism=EXCLUDED.mapping_mechanism, validation_status=EXCLUDED.validation_status,
          identity_fields=EXCLUDED.identity_fields, provenance=EXCLUDED.provenance,
          resolver_version=EXCLUDED.resolver_version,
          last_validated_at=NOW(), updated_at=NOW()
        RETURNING *
      `, [entity.entityId, mapping.source, mapping.sourceEntityId, mapping.sourceEntityName, mapping.sourceEntityType,
        mapping.environment, mapping.evidenceLevel || mapping.level, mapping.score, JSON.stringify(mapping.reasons || []),
        mapping.mappingMechanism || 'deterministic_inventory_match', JSON.stringify(mapping.metadata || {}),
        JSON.stringify(mapping.provenance?.identityEvidence || []), SOURCE_IDENTITY_CONFIG.resolverVersion, status]);
      return mapValidatedRow(result.rows[0]);
    },
  };
}

function applyValidatedMappings(source, mappings = [], validated = [], inventory) {
  const automatic = mappings.filter((mapping) => mapping.source === source);
  const byId = new Map((inventory?.items || inventory || []).map((item) => [String(item.id), item]));
  const currentIds = new Set(automatic.filter((mapping) => ACCEPTED_VALIDATION_LEVELS.has(mapping.level)).map((mapping) => String(mapping.sourceEntityId)));
  const restored = validated.filter((item) => item.source === source).map((saved) => {
    const item = byId.get(String(saved.sourceEntityId));
    if (!item || !environmentCompatible(saved.environment, item.environment || environmentFromText(item.name))) {
      return {
        source, sourceEntityId: saved.sourceEntityId, sourceEntityName: saved.sourceEntityName,
        sourceEntityType: saved.sourceEntityType, environment: saved.environment || null,
        level: 'STALE_MAPPING', mappingState: 'STALE', evidenceLevel: saved.evidenceLevel, score: saved.score,
        reasons: unique([...(saved.reasons || []), `The persisted ${source} entity was not present in the current read-only inventory.`]),
        status: 'STALE', mappingMechanism: saved.mappingMechanism || 'persisted_validated_mapping',
        usableForSourceValidation: false,
        provenance: { automatic: true, manual: false, sourceSystem: source, createdAt: saved.firstValidatedAt, lastValidatedAt: saved.lastValidatedAt },
        metadata: source === 'AppDynamics' ? { applicationId: saved.sourceEntityType === 'APPLICATION' ? saved.sourceEntityId : null } : {},
      };
    }
    if (currentIds.has(String(saved.sourceEntityId))) return null;
    return mappingRecord(source, item, ['EXACT', 'STRONG'].includes(saved.evidenceLevel) ? saved.evidenceLevel : 'STRONG', saved.score, [
      ...(saved.reasons || []),
      `Persisted deterministic mapping was revalidated against the current ${source} inventory.`,
    ], {
      mappingMechanism: 'persisted_validated_mapping',
      identitySource: 'VALIDATED_MAPPING',
      identityEvidence: saved.provenance || [],
      metadata: saved.identityFields || {},
      createdAt: saved.firstValidatedAt,
      lastValidatedAt: new Date().toISOString(),
    });
  }).filter(Boolean);
  return dedupeMappings([...automatic, ...restored], Math.max(3, automatic.length + restored.length));
}

function applyDecisions(mappings, decisions = []) {
  const byKey = new Map(decisions.map((decision) => [`${decision.source}|${decision.sourceEntityId}`, decision]));
  return mappings.map((mapping) => {
    const decision = byKey.get(`${mapping.source}|${mapping.sourceEntityId}`);
    if (!decision) return mapping;
    if (decision.decision === 'REJECTED_LOCAL') return { ...mapping, status: 'REJECTED_LOCAL', rejected: true, usableForSourceValidation: false, provenance: { ...mapping.provenance, manual: true, confirmedBy: decision.confirmedBy, confirmedAt: decision.confirmedAt } };
    return {
      ...mapping,
      level: 'CONFIRMED_LOCAL',
      mappingState: 'CONFIRMED_LOCAL',
      evidenceLevel: decision.evidenceLevel || mapping.level,
      status: 'CONFIRMED_LOCAL',
      usableForSourceValidation: true,
      reasons: unique([...mapping.reasons, 'Mapping confirmed in the local Alert Noise Reduction registry']),
      provenance: { ...mapping.provenance, automatic: false, manual: true, confirmedBy: decision.confirmedBy, confirmedAt: decision.confirmedAt },
    };
  });
}

function normalizedIdentityTargets(identity, mappings, conflicts = [], resolverVersion = SOURCE_IDENTITY_CONFIG.resolverVersion) {
  const sourceEntries = [
    ['AppDynamics', mappings.appDynamics], ['Grafana', mappings.grafana],
    ['Nagios', mappings.nagios], ['ThousandEyes', mappings.thousandEyes],
  ];
  const conflictSources = new Set(conflicts.flatMap((conflict) => [
    conflict.source,
    ...(conflict.mappings || conflict.environments?.flatMap((item) => item.mappings || []) || []).map((item) => item.source),
  ]).filter(Boolean));
  return sourceEntries.map(([source, entries]) => {
    const active = (entries || []).filter((item) => item && item.level !== 'NONE' && !item.rejected);
    const accepted = active.filter((item) => ACCEPTED_VALIDATION_LEVELS.has(item.level) && item.usableForSourceValidation !== false);
    const candidates = active.filter((item) => item.level === 'CANDIDATE');
    const stale = active.filter((item) => item.mappingState === 'STALE' || item.level === 'STALE_MAPPING');
    const exclusiveKinds = new Set(accepted.map((item) => String(item.sourceEntityType || '').toUpperCase())
      .filter((kind) => ['ALERT_RULE', 'HEALTH_RULE', 'TEST'].includes(kind)));
    const conflict = conflictSources.has(source) || (exclusiveKinds.size > 0
      && new Set(accepted.filter((item) => exclusiveKinds.has(String(item.sourceEntityType || '').toUpperCase()))
        .map((item) => `${item.sourceEntityType}:${item.sourceEntityId}`)).size > 1);
    const selected = conflict ? null : accepted[0] || candidates[0] || stale[0] || null;
    const metadata = selected?.metadata || {};
    const raw = identity.rawExtraction?.extracted || {};
    const extractionFields = source === 'AppDynamics'
      ? ['applicationIds', 'applicationNames', 'tierIds', 'tierNames', 'nodeIds', 'nodeNames',
        'businessTransactionIds', 'businessTransactionNames', 'healthRuleIds', 'healthRuleNames',
        'policyIds', 'policyNames', 'eventIds', 'violationIds', 'deepLinks']
      : source === 'Grafana'
        ? ['ruleUids', 'ruleNames', 'dashboardUids', 'panelIds', 'datasourceIds', 'instances',
          'serviceNames', 'environmentNames', 'deepLinks']
        : source === 'Nagios'
          ? ['hostIds', 'hostNames', 'serviceIds', 'serviceNames', 'environmentNames', 'deepLinks']
          : ['testIds', 'targets', 'agents', 'sourceEntityIds', 'deepLinks'];
    const rawProvenance = (identity.rawExtraction?.provenance || []).filter((entry) => extractionFields.includes(entry.field));
    const entityType = cleanText(selected?.sourceEntityType).toUpperCase() || null;
    const mappingState = conflict ? 'CONFLICT' : selected?.mappingState === 'STALE' || selected?.level === 'STALE_MAPPING'
      ? 'STALE' : (selected?.level === 'NONE' || !selected ? 'UNKNOWN' : selected.level);
    const evidenceMissing = [];
    if (!selected) evidenceMissing.push(`${source} source object ID or exact structured entity identity`);
    else if (mappingState === 'CANDIDATE') evidenceMissing.push('A deterministic discriminator such as an explicit source ID or exact structured combination');
    else if (mappingState === 'CONFLICT') evidenceMissing.push('A deterministic field that selects one conflicting source entity');
    else if (mappingState === 'STALE') evidenceMissing.push('Current source inventory validation');
    return {
      source,
      sourceEntityType: entityType,
      sourceEntityId: selected?.sourceEntityId || null,
      sourceEntityName: selected?.sourceEntityName || null,
      application: entityType === 'APPLICATION' ? selected?.sourceEntityName : null,
      service: entityType === 'SERVICE' ? selected?.sourceEntityName : identity.services?.[0] || null,
      environment: selected?.environment || identity.environment || null,
      host: metadata.host || (entityType === 'HOST' ? selected?.sourceEntityName : identity.hosts?.[0]) || null,
      node: entityType === 'NODE' ? selected?.sourceEntityName : null,
      tier: metadata.tierName || (entityType === 'TIER' ? selected?.sourceEntityName : null),
      businessTransaction: entityType === 'BUSINESS_TRANSACTION' ? selected?.sourceEntityName : identity.businessTransactions?.[0] || null,
      ruleId: ['ALERT_RULE', 'HEALTH_RULE'].includes(entityType) ? selected?.sourceEntityId : null,
      ruleName: ['ALERT_RULE', 'HEALTH_RULE'].includes(entityType) ? selected?.sourceEntityName : identity.rules?.[0] || null,
      dashboardId: metadata.dashboardUid || (entityType === 'DASHBOARD' ? selected?.sourceEntityId : null),
      panelId: metadata.panelId || null,
      testId: metadata.testId || (entityType === 'TEST' ? selected?.sourceEntityId : null),
      targetId: metadata.targetId || null,
      hostId: entityType === 'HOST' ? selected?.sourceEntityId : null,
      serviceId: entityType === 'SERVICE' ? selected?.sourceEntityId : null,
      applicationId: source === 'AppDynamics' ? raw.applicationIds?.[0] || metadata.applicationId || null : null,
      tierId: source === 'AppDynamics' ? raw.tierIds?.[0] || null : null,
      nodeId: source === 'AppDynamics' ? raw.nodeIds?.[0] || null : null,
      businessTransactionId: source === 'AppDynamics' ? raw.businessTransactionIds?.[0] || null : null,
      healthRuleId: source === 'AppDynamics' ? raw.healthRuleIds?.[0] || null : null,
      healthRuleName: source === 'AppDynamics' ? raw.healthRuleNames?.[0] || null : null,
      policyId: source === 'AppDynamics' ? raw.policyIds?.[0] || null : null,
      policyName: source === 'AppDynamics' ? raw.policyNames?.[0] || null : null,
      eventId: source === 'AppDynamics' ? raw.eventIds?.[0] || null : null,
      violationId: source === 'AppDynamics' ? raw.violationIds?.[0] || null : null,
      datasourceId: source === 'Grafana' ? raw.datasourceIds?.[0] || null : null,
      instance: source === 'Grafana' ? raw.instances?.[0] || null : null,
      target: source === 'ThousandEyes' ? raw.targets?.[0] || null : null,
      agents: source === 'ThousandEyes' ? raw.agents || [] : [],
      mappingState,
      mappingConfidence: selected?.score || 0,
      identitySource: selected?.identitySource || null,
      evidenceUsed: selected?.reasons || [],
      evidenceMissing,
      reasoning: conflict ? 'Multiple deterministic candidates conflict; automatic source querying is blocked.'
        : selected?.reasons?.join(' ') || `No deterministic ${source} identity was found in structured Operations fields or current inventory.`,
      candidateEntities: candidates.map((item) => ({ id: item.sourceEntityId, name: item.sourceEntityName, type: item.sourceEntityType, confidence: item.score })),
      identityExtraction: {
        inspected: true,
        sourcesSearched: ['Raw payload', 'Structured metadata', 'Deep links', 'Labels/tags', 'Annotations', 'Source metadata'],
        fieldsFound: unique(rawProvenance.map((entry) => entry.field)),
        fieldsMissing: extractionFields.filter((field) => !(raw[field] || []).length),
        provenance: rawProvenance.slice(0, 50),
        valuesExtracted: rawProvenance.length,
        redactionApplied: true,
      },
      resolverVersion,
      resolvedAt: new Date().toISOString(),
      handoffStatus: ACCEPTED_VALIDATION_LEVELS.has(mappingState) ? 'IDENTITY_READY' : 'IDENTITY_INCOMPLETE',
    };
  });
}

function detectConflicts(identity, mappingsBySource) {
  const accepted = Object.values(mappingsBySource).flat().filter((item) => item.usableForSourceValidation && !item.rejected);
  const environments = new Map();
  accepted.forEach((item) => {
    const environment = normalizeEnvironment(item.environment);
    if (!environment) return;
    const domain = environmentDomain(environment);
    const key = `${domain || 'OTHER'}:${environment}`;
    const values = environments.get(key)?.items || [];
    values.push({ source: item.source, sourceEntityName: item.sourceEntityName });
    environments.set(key, { domain, environment, items: values });
  });
  const expected = normalizeEnvironment(identity.environment);
  const expectedDomain = environmentDomain(expected);
  const conflicts = (identity.rawExtraction?.conflicts || []).map((conflict) => {
    const normalizedSource = SOURCE_KEYS[Object.keys(SOURCE_KEYS).find((key) => (
      normalizeIdentity(SOURCE_KEYS[key]) === normalizeIdentity(conflict.source)
    ))] || conflict.source || identity.sources?.[0] || 'Unknown';
    return {
      type: 'RAW_IDENTITY_CONFLICT',
      source: normalizedSource,
      field: conflict.field,
      values: conflict.values,
      reason: conflict.reason,
      provenance: conflict.provenance,
      mappings: Object.values(mappingsBySource).flat().filter((item) => item.source === normalizedSource),
    };
  });
  if (expected) {
    for (const { domain, environment, items } of environments.values()) {
      // Nagios data-center identity (DC01/DC02) and deployment tier
      // (production/QA/etc.) describe separate dimensions. An exact host/service
      // match in DC01 is therefore not contradicted by an Operations alert whose
      // deployment tier is production.
      if (domain !== expectedDomain) continue;
      if (environment !== expected) conflicts.push({ type: 'ENVIRONMENT_MISMATCH', expected, found: environment, mappings: items });
    }
  } else {
    const byDomain = new Map();
    for (const entry of environments.values()) {
      const values = byDomain.get(entry.domain) || [];
      values.push(entry);
      byDomain.set(entry.domain, values);
    }
    for (const entries of byDomain.values()) {
      if (entries.length <= 1) continue;
      conflicts.push({
        type: 'CROSS_SOURCE_ENVIRONMENT_CONFLICT',
        environments: entries.map(({ environment, items }) => ({ environment, mappings: items })),
      });
    }
  }
  return conflicts;
}

function detectInventoryRelationshipConflicts(identity, inventories, mappingsBySource) {
  const conflicts = [];
  const applicationIds = new Set((identity.appDynamicsApplicationIds || []).map(String));
  if (applicationIds.size) {
    const childIds = new Set([
      ...(identity.appDynamicsNodeIds || []), ...(identity.appDynamicsTierIds || []),
      ...(identity.appDynamicsBusinessTransactionIds || []), ...(identity.appDynamicsHealthRuleIds || []),
    ].map(String));
    const invalid = (inventories.appDynamics?.items || []).filter((item) => childIds.has(String(item.id))
      && item.applicationId && !applicationIds.has(String(item.applicationId)));
    if (invalid.length) conflicts.push({
      type: 'APPDYNAMICS_PARENT_CHILD_CONFLICT',
      source: 'AppDynamics',
      values: invalid.map((item) => ({ id: String(item.id), applicationId: String(item.applicationId), type: item.sourceEntityType })),
      reason: 'An extracted AppDynamics child entity belongs to a different application than the extracted Application ID.',
      mappings: mappingsBySource.appDynamics || [],
    });
  }
  const dashboardUids = new Set((identity.grafanaDashboardUids || []).map(String));
  const panelIds = new Set((identity.grafanaPanelIds || []).map(String));
  if (dashboardUids.size && panelIds.size) {
    const invalid = (inventories.grafana?.items || []).filter((item) => item.kind === 'panel'
      && panelIds.has(String(item.panelId || item.id)) && item.dashboardUid && !dashboardUids.has(String(item.dashboardUid)));
    if (invalid.length && !(inventories.grafana?.items || []).some((item) => item.kind === 'panel'
      && panelIds.has(String(item.panelId || item.id)) && dashboardUids.has(String(item.dashboardUid)))) {
      conflicts.push({
        type: 'GRAFANA_DASHBOARD_PANEL_CONFLICT',
        source: 'Grafana',
        values: invalid.map((item) => ({ dashboardUid: String(item.dashboardUid), panelId: String(item.panelId || item.id) })),
        reason: 'The extracted Grafana panel ID was not related to the extracted dashboard UID in current inventory.',
        mappings: mappingsBySource.grafana || [],
      });
    }
  }
  return conflicts;
}

function emptyMapping(source, reason, available) {
  return { source, level: 'NONE', mappingState: 'UNKNOWN', evidenceLevel: 'UNKNOWN', score: 0, reasons: [reason], status: available ? 'NO_MATCH' : 'UNAVAILABLE', usableForSourceValidation: false, provenance: { automatic: true, manual: false, sourceSystem: source, createdAt: null, lastValidatedAt: null } };
}

function createSourceIdentityService({
  config = SOURCE_IDENTITY_CONFIG,
  inventoryLoader = loadSourceInventories,
  phase1Service = alertFoundationService,
  registryStoreFactory = defaultRegistryStore,
  discovery = null,
  now = () => Date.now(),
} = {}) {
  let inventoryCache = null;
  let inventoryPromise = null;
  let registryPromise = null;
  const coverageCache = new Map();
  const coverageKey = (range, discoveryEnabled = true) => `${range}:${discoveryEnabled ? 'discovery' : 'base'}`;

  async function registry() {
    if (!registryPromise) registryPromise = Promise.resolve(registryStoreFactory());
    return registryPromise;
  }

  async function getInventories(refresh = false) {
    if (!refresh && inventoryCache && now() - inventoryCache.cachedAtMs < config.cacheTtlMs) return { ...inventoryCache.value, cacheHit: true };
    if (!refresh && inventoryPromise) return inventoryPromise;
    const startedAt = now();
    inventoryPromise = Promise.resolve(inventoryLoader()).then((value) => {
      const prepared = prepareInventories(value);
      const result = { ...prepared, buildTimeMs: value.buildTimeMs ?? Math.max(0, now() - startedAt), cacheTtlMs: config.cacheTtlMs, cacheHit: false };
      inventoryCache = { cachedAtMs: now(), value: result };
      return result;
    }).finally(() => { inventoryPromise = null; });
    return inventoryPromise;
  }

  async function getDiscoveryCatalogs(inventories, refresh = false) {
    if (!discovery?.getCatalogs) return null;
    return discovery.getCatalogs({ fallbackInventories: inventories, refresh });
  }

  function supportedGroupSources(group) {
    return unique([
      ...(group.alerts || []).map((alert) => canonicalSource(alert.sourceSystem || alert.source || alert.integration)),
      ...(group.sources || []).map(canonicalSource),
    ]).filter((source) => ['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes'].includes(source));
  }

  function sourceScopedGroup(group, source) {
    const alerts = (group.alerts || []).filter((alert) => (
      canonicalSource(alert.sourceSystem || alert.source || alert.integration) === source
    ));
    return { ...group, alerts, sources: [source] };
  }

  function existingDiscoveryResult(group, source, preliminary, catalogs) {
    const target = preliminary.normalizedIdentities.find((item) => item.source === source);
    if (!target || !ACCEPTED_VALIDATION_LEVELS.has(target.mappingState)) return null;
    return {
      source,
      discoveryState: target.mappingState,
      entityType: target.sourceEntityType,
      entityId: target.sourceEntityId,
      entityName: target.sourceEntityName,
      sourceSpecificIdentity: {},
      candidates: [], matchingAttributes: [], conflictingAttributes: [],
      evidenceUsed: target.evidenceUsed || [], evidenceMissing: [],
      reasoning: 'The existing deterministic source-inventory mapping is already accepted and was reused.',
      blocker: null, inventoryVersion: catalogs?.version || null,
      patternKey: group.groupId, cacheHit: true, accepted: true,
      reusedExistingIdentity: true, readOnly: true, externalMutations: 'none', classificationDecision: null,
      occurrenceCount: (group.alerts || []).length,
    };
  }

  function discoverGroup(group, preliminary, catalogs) {
    if (!discovery) return [];
    return supportedGroupSources(group).map((source) => {
      const scopedGroup = sourceScopedGroup(group, source);
      if (!scopedGroup.alerts.length) return null;
      const scopedIdentity = extractOperationsIdentity(scopedGroup, now);
      const reused = existingDiscoveryResult(scopedGroup, source, preliminary, catalogs);
      if (reused || !discovery?.discover) return reused;
      return {
        ...discovery.discover({
          alertId: `${group.groupId}:${source}`,
          source,
          knownIdentity: scopedIdentity,
          normalizedAlert: scopedGroup.alerts[0] || null,
          normalizedAlerts: scopedGroup.alerts,
          rawIdentityEvidence: scopedIdentity.rawExtraction || null,
        }, catalogs),
        occurrenceCount: scopedGroup.alerts.length,
      };
    }).filter(Boolean);
  }

  function resolveWithInventories(group, inventories, decisions = [], extractedIdentity = null, validatedMappings = [], discoveryResults = []) {
    const startedAt = now();
    const identity = extractedIdentity || extractOperationsIdentity(group, now);
    const automatic = {
      appDynamics: appDynamicsMappings(identity, inventories.appDynamics, config),
      grafana: grafanaMappings(identity, inventories.grafana, config),
      thousandEyes: thousandEyesMappings(identity, inventories.thousandEyes, config),
      nagios: nagiosMappings(identity, inventories.nagios, config),
    };
    const discoveries = Array.isArray(discoveryResults) ? discoveryResults : discoveryResults ? [discoveryResults] : [];
    discoveries.forEach((discoveryResult) => {
      const discoveredMapping = mappingFromDiscovery(discoveryResult);
      const discoveredKey = discoveryResult?.source === 'AppDynamics' ? 'appDynamics'
        : discoveryResult?.source === 'Grafana' ? 'grafana'
          : discoveryResult?.source === 'Nagios' ? 'nagios'
            : discoveryResult?.source === 'ThousandEyes' ? 'thousandEyes' : null;
      if (discoveredMapping && discoveredKey) {
        automatic[discoveredKey] = dedupeMappings(
          [discoveredMapping, ...automatic[discoveredKey]],
          Math.max(config.maxCandidatesPerSource, automatic[discoveredKey].length + 1),
        );
      }
    });
    const mappingsBySource = {
      appDynamics: applyDecisions(applyValidatedMappings('AppDynamics', automatic.appDynamics, validatedMappings, inventories.appDynamics), decisions),
      grafana: applyDecisions(applyValidatedMappings('Grafana', automatic.grafana, validatedMappings, inventories.grafana), decisions),
      thousandEyes: applyDecisions(applyValidatedMappings('ThousandEyes', automatic.thousandEyes, validatedMappings, inventories.thousandEyes), decisions),
      nagios: applyDecisions(applyValidatedMappings('Nagios', automatic.nagios, validatedMappings, inventories.nagios), decisions),
      jira: applyDecisions(jiraMappings(identity, inventories.jira, config), decisions),
    };
    const activeBySource = Object.fromEntries(Object.entries(mappingsBySource).map(([key, mappings]) => [key, mappings.filter((mapping) => !mapping.rejected)]));
    const sourceMapping = (key) => activeBySource[key].length ? activeBySource[key] : [emptyMapping(SOURCE_KEYS[key], `No exact or strong deterministic ${SOURCE_KEYS[key]} identifier/name relationship was found.`, inventories.status?.[key]?.available !== false)];
    const mappings = {
      operations: [{
        source: 'JSM Operations', sourceEntityId: group.groupId, sourceEntityName: identity.canonicalName, sourceEntityType: identity.entityType,
        environment: identity.environment, level: 'EXACT', evidenceLevel: 'EXACT', score: 100, status: 'AUTHORITATIVE',
        reasons: ['Canonical entity was extracted from structured JSM Operations fields before normalized alert text.'],
        usableForSourceValidation: true,
        provenance: { automatic: true, manual: false, sourceSystem: 'JSM Operations', createdAt: identity.firstSeen, lastValidatedAt: identity.lastSeen },
      }],
      appDynamics: sourceMapping('appDynamics'),
      grafana: sourceMapping('grafana'),
      thousandEyes: sourceMapping('thousandEyes'),
      nagios: sourceMapping('nagios'),
      jira: sourceMapping('jira').map((item) => ({ ...item, relationship: item.metadata?.relationship || (item.level === 'NONE' ? 'NONE' : 'CANDIDATE') })),
      slack: {
        source: 'Slack',
        status: identity.alertNumbers.length ? 'CONTEXT_AVAILABLE' : 'NO_EXACT_REFERENCE',
        reinforced: identity.alertNumbers.length > 0,
        reasons: identity.alertNumbers.length ? [`${identity.alertNumbers.length} exact Operations alert number${identity.alertNumbers.length === 1 ? '' : 's'} available for Slack correlation`, 'Slack remains contextual and does not create the canonical entity.'] : ['No exact alert number is available for deterministic Slack reinforcement.'],
      },
    };
    const conflicts = [
      ...detectConflicts(identity, activeBySource),
      ...detectInventoryRelationshipConflicts(identity, inventories, activeBySource),
      ...discoveries.filter((item) => item.discoveryState === 'CONFLICT').map((item) => ({
        type: 'SOURCE_DISCOVERY_CONFLICT',
        source: item.source,
        values: item.candidates,
        reason: item.reasoning,
        provenance: item.matchingAttributes,
        mappings: activeBySource[item.source === 'AppDynamics' ? 'appDynamics'
          : item.source === 'Grafana' ? 'grafana' : item.source === 'Nagios' ? 'nagios' : 'thousandEyes'] || [],
      })),
    ];
    const normalizedIdentities = normalizedIdentityTargets(identity, mappings, conflicts, config.resolverVersion).map((target) => {
      const discoveryResult = discoveries.find((item) => item.source === target.source);
      return discoveryResult ? {
        ...target,
        discovery: discoveryResult,
        sourceSpecificIdentity: discoveryResult.sourceSpecificIdentity || {},
        evidenceMissing: discoveryResult.accepted ? target.evidenceMissing
          : unique([...(target.evidenceMissing || []), ...(discoveryResult.evidenceMissing || [])]),
        reasoning: discoveryResult.reasoning || target.reasoning,
      } : target;
    });
    const monitoringMappings = ['appDynamics', 'grafana', 'thousandEyes', 'nagios'].flatMap((key) => mappings[key]).filter((item) => item.level !== 'NONE');
    const allMappings = [...monitoringMappings, ...mappings.jira.filter((item) => item.level !== 'NONE')];
    return {
      phase: '2.8',
      groupId: group.groupId,
      canonicalEntity: {
        entityId: identity.entityId,
        canonicalName: identity.canonicalName,
        entityType: ENTITY_TYPES.has(identity.entityType) ? identity.entityType : 'UNKNOWN',
        environment: identity.environment,
        platform: null,
        team: unique((group.alerts || []).flatMap((alert) => [alert.team, ...valuesForKeys(alert, /^(team|ownerTeam)$/i).map((item) => item.value)]))[0] || null,
        aliases: identity.deterministicAliases,
        firstSeen: identity.firstSeen,
        lastSeen: identity.lastSeen,
      },
      operationsIdentity: {
        structuredFirst: true,
        applications: identity.applications,
        services: identity.services,
        hosts: identity.hosts,
        businessTransactions: identity.businessTransactions,
        sourceIdentifiers: identity.sourceIds,
        operationsIds: identity.operationsIds,
        alertNumbers: identity.alertNumbers,
        environmentCandidates: identity.environments,
        deepLinks: identity.deepLinks?.links || [],
        rawPayloadPreserved: true,
        normalizedPayloadPreserved: true,
        extraction: {
          summary: identity.rawExtraction?.summary || null,
          extracted: identity.rawExtraction?.extracted || {},
          provenance: identity.rawExtraction?.provenance || [],
          conflicts: identity.rawExtraction?.conflicts || [],
          fieldsSearched: identity.rawExtraction?.fieldsSearched || [],
          fieldsFound: identity.rawExtraction?.fieldsFound || [],
          fieldsMissing: identity.rawExtraction?.fieldsMissing || [],
          redactionApplied: true,
        },
      },
      normalizedIdentities,
      sourceDiscovery: discoveries[0] || null,
      sourceDiscoveries: discoveries,
      mappings,
      summary: {
        exact: allMappings.filter((item) => item.level === 'EXACT').length,
        strong: allMappings.filter((item) => item.level === 'STRONG').length,
        candidate: allMappings.filter((item) => item.level === 'CANDIDATE').length,
        stale: allMappings.filter((item) => item.level === 'STALE_MAPPING').length,
        confirmedLocal: allMappings.filter((item) => item.level === 'CONFIRMED_LOCAL').length,
        rejectedLocal: decisions.filter((item) => item.decision === 'REJECTED_LOCAL').length,
        mappedMonitoringSources: new Set(monitoringMappings.filter((item) => item.usableForSourceValidation).map((item) => item.source)).size,
        conflicts: conflicts.length,
      },
      conflicts,
      mappingConflict: conflicts.length > 0,
      performance: {
        cacheHit: inventories.cacheHit === true,
        cacheTtlMs: config.cacheTtlMs,
        coldIndexBuildTimeMs: inventories.buildTimeMs,
        resolutionTimeMs: Math.max(0, now() - startedAt),
      },
      readOnlySources: true,
      externalMutations: 'none',
      localDecisionWrites: 'confirm_or_reject_only',
      aiUsed: false,
    };
  }

  async function resolveGroup(group, options = {}) {
    const inventories = options.inventories || await getInventories(options.refresh === true);
    const identity = extractOperationsIdentity(group, now);
    let decisions = options.decisions || [];
    let validatedMappings = options.validatedMappings || [];
    let registryStore = null;
    if (!options.decisions) {
      try {
        registryStore = await registry();
        decisions = await registryStore.get(identity.entityId);
      } catch { decisions = []; }
    }
    if (!options.validatedMappings) {
      try {
        registryStore = registryStore || await registry();
        validatedMappings = registryStore.getValidated ? await registryStore.getValidated(identity.entityId) : [];
      } catch { validatedMappings = []; }
    }
    const preliminary = resolveWithInventories(group, inventories, decisions, identity, validatedMappings);
    const catalogs = options.discoveryCatalogs || await getDiscoveryCatalogs(inventories, options.refresh === true);
    const discoveryResults = discoverGroup(group, preliminary, catalogs);
    const resolved = discoveryResults.length
      ? resolveWithInventories(group, inventories, decisions, identity, validatedMappings, discoveryResults)
      : preliminary;
    try {
      registryStore = registryStore || await registry();
      if (registryStore.saveValidated) {
        for (const mapping of ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].flatMap((key) => resolved.mappings[key] || [])
          .filter((item) => ['EXACT', 'STRONG', 'STALE_MAPPING'].includes(item.level))) {
          await registryStore.saveValidated(resolved.canonicalEntity, mapping, mapping.level === 'STALE_MAPPING' ? 'STALE' : 'VALID');
        }
      }
    } catch { /* Local registry persistence is advisory; deterministic mapping remains available. */ }
    return resolved;
  }

  async function resolve(options = {}) {
    const requestStartedAt = now();
    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '7d';
    let group;
    if (options.groupId) {
      const cachedCoverage = coverageCache.get(coverageKey(range, Boolean(discovery)));
      if (options.refresh !== true && cachedCoverage && now() - cachedCoverage.cachedAtMs < config.cacheTtlMs) {
        const cachedResolution = cachedCoverage.resolved.find((item) => item.groupId === String(options.groupId));
        if (cachedResolution) {
          return {
            ...cachedResolution,
            performance: {
              ...cachedResolution.performance,
              cacheHit: true,
              resolutionTimeMs: Math.max(0, now() - requestStartedAt),
              resolutionSource: 'coverage_cache',
            },
          };
        }
      }
      group = (await phase1Service.getGroup(String(options.groupId), { range, refresh: options.refresh })).group;
    } else if (options.pattern) {
      const result = await phase1Service.analyzeRange(range, options.refresh === true);
      const target = normalizeIdentity(options.pattern);
      group = result.groups.find((item) => normalizeIdentity(item.pattern) === target || normalizeIdentity(extractOperationsIdentity(item, now).canonicalName) === target);
      if (!group) throw safeError('No alert foundation pattern matched the requested deterministic identity.', 'SOURCE_IDENTITY_PATTERN_NOT_FOUND', 404);
    } else {
      throw safeError('groupId or pattern is required.', 'SOURCE_IDENTITY_INPUT_REQUIRED');
    }
    return resolveGroup(group, options);
  }

  async function getCoverage(options = {}) {
    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '90d';
    const discoveryEnabled = Boolean(discovery) && options.sourceDiscovery !== false;
    const cacheKey = coverageKey(range, discoveryEnabled);
    const startedAt = now();
    const page = Math.max(1, Number(options.page) || 1);
    const size = Math.max(1, Math.min(100, Number(options.size) || 25));
    const cached = coverageCache.get(cacheKey);
    if (options.refresh !== true && cached && now() - cached.cachedAtMs < config.cacheTtlMs) {
      const start = (page - 1) * size;
      return {
        ...cached.base,
        entities: cached.resolved.slice(start, start + size).map((item) => ({
          groupId: item.groupId,
          canonicalEntity: item.canonicalEntity,
          summary: item.summary,
          mappings: item.mappings,
          normalizedIdentities: item.normalizedIdentities,
          operationsIdentity: item.operationsIdentity,
          sourceDiscovery: item.sourceDiscovery,
          sourceDiscoveries: item.sourceDiscoveries,
          conflicts: item.conflicts,
        })),
        pagination: { page, size, total: cached.resolved.length, totalPages: Math.max(1, Math.ceil(cached.resolved.length / size)) },
        performance: { ...cached.base.performance, executionTimeMs: Math.max(0, now() - startedAt), cacheHit: true },
      };
    }
    const [analysis, inventories] = await Promise.all([
      phase1Service.analyzeRange(range, options.refresh === true),
      getInventories(options.refresh === true),
    ]);
    let decisions = [];
    let validatedMappings = [];
    let registryStore = null;
    try {
      registryStore = await registry();
      decisions = await registryStore.getAll();
      validatedMappings = registryStore.getAllValidated ? await registryStore.getAllValidated() : [];
    } catch { decisions = []; validatedMappings = []; }
    const byEntity = new Map();
    decisions.forEach((decision) => {
      const items = byEntity.get(decision.entityId) || [];
      items.push(decision);
      byEntity.set(decision.entityId, items);
    });
    const validatedByEntity = new Map();
    validatedMappings.forEach((mapping) => {
      const items = validatedByEntity.get(mapping.entityId) || [];
      items.push(mapping);
      validatedByEntity.set(mapping.entityId, items);
    });
    const catalogs = discoveryEnabled ? await getDiscoveryCatalogs(inventories, options.refresh === true) : null;
    const identityGroups = discoveryEnabled ? sourceIdentityGroups(analysis) : analysis.groups;
    const resolved = identityGroups.map((group) => {
      const identity = extractOperationsIdentity(group, now);
      const automaticDecisions = byEntity.get(identity.entityId) || [];
      const persisted = validatedByEntity.get(identity.entityId) || [];
      const preliminary = resolveWithInventories(group, inventories, automaticDecisions, identity, persisted);
      const discoveryResults = discoveryEnabled ? discoverGroup(group, preliminary, catalogs) : [];
      return discoveryResults.length
        ? resolveWithInventories(group, inventories, automaticDecisions, identity, persisted, discoveryResults)
        : preliminary;
    });
    if (registryStore?.saveValidated) {
      for (const item of resolved) {
        for (const mapping of ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].flatMap((key) => item.mappings[key] || [])
          .filter((entry) => ['EXACT', 'STRONG', 'STALE_MAPPING'].includes(entry.level))) {
          try { await registryStore.saveValidated(item.canonicalEntity, mapping, mapping.level === 'STALE_MAPPING' ? 'STALE' : 'VALID'); } catch { /* Coverage remains usable when local persistence is unavailable. */ }
        }
      }
    }
    const sourceCounts = {};
    for (const [key, label] of Object.entries(SOURCE_KEYS)) {
      const sourceMappings = resolved.map((item) => item.mappings[key]);
      const highestLevel = (items) => {
        if (items.some((item) => item.level === 'CONFIRMED_LOCAL' || item.relationship === 'CONFIRMED')) return 'CONFIRMED';
        if (items.some((item) => item.level === 'EXACT')) return 'EXACT';
        if (items.some((item) => item.level === 'STRONG')) return 'STRONG';
        if (items.some((item) => item.level === 'CANDIDATE')) return 'CANDIDATE';
        return 'NONE';
      };
      const levels = sourceMappings.map(highestLevel);
      sourceCounts[label] = {
        exact: levels.filter((level) => level === 'EXACT').length,
        strong: levels.filter((level) => level === 'STRONG').length,
        candidate: levels.filter((level) => level === 'CANDIDATE').length,
        stale: sourceMappings.filter((items) => items.some((item) => item.level === 'STALE_MAPPING')).length,
        confirmed: levels.filter((level) => level === 'CONFIRMED').length,
        none: levels.filter((level) => level === 'NONE').length,
      };
    }
    const mapped = resolved.filter((item) => item.summary.mappedMonitoringSources > 0);
    const discoverySources = ['Grafana', 'AppDynamics', 'Nagios', 'ThousandEyes'];
    const sourceDiscovery = {
      phase: '5F',
      catalogVersion: catalogs?.version || null,
      catalogCacheHit: catalogs?.cacheHit === true,
      catalogExternalCalls: Number(catalogs?.externalCalls || 0),
      maxConcurrency: discovery?.maxConcurrency || config.coverageConcurrency,
      cacheTtlMs: catalogs?.cacheTtlMs || config.cacheTtlMs,
      catalogs: Object.fromEntries(discoverySources.map((source) => {
        const items = catalogs?.sources?.[source]?.items || [];
        return [source, {
          available: catalogs?.sources?.[source]?.available === true,
          records: items.length,
          rules: items.filter((item) => item.kind === 'alert_rule').length,
          pages: Number(catalogs?.sources?.[source]?.pages || 0),
          source: catalogs?.sources?.[source]?.source || 'unavailable',
          error: catalogs?.sources?.[source]?.error || null,
        }];
      })),
      sources: Object.fromEntries(discoverySources.map((source) => {
        const items = resolved.flatMap((item) => item.sourceDiscoveries || (item.sourceDiscovery ? [item.sourceDiscovery] : []))
          .filter((item) => item.source === source);
        const count = (state) => items.filter((item) => item.discoveryState === state)
          .reduce((total, item) => total + Number(item.occurrenceCount || 0), 0);
        return [source, {
          occurrences: items.reduce((total, item) => total + Number(item.occurrenceCount || 0), 0),
          patterns: items.length,
          exact: count('EXACT'), strong: count('STRONG'), conflict: count('CONFLICT'), unknown: count('UNKNOWN'),
          unsupported: count('UNSUPPORTED'),
          reusedPatterns: items.filter((item) => item.cacheHit || item.reusedExistingIdentity).length,
        }];
      })),
      acceptedPatternReuseOnly: true,
      candidateMappingsQueried: 0,
      ambiguousMappingsPromoted: 0,
      externalMutations: 'none',
    };
    const rawPayloadFieldCoverage = summarizeExtractions((analysis._normalizedAlerts || []).map((alert) => (
      alert.identityExtractionMetadata || extractRawOperationsIdentity(alert.rawPayload || alert, {
        alertId: alert.id,
        source: alert.sourceSystem || alert.source,
      })
    )));
    const start = (page - 1) * size;
    const base = {
      phase: '2.8',
      rawIdentityPhase: '5E',
      sourceDiscoveryPhase: '5F',
      range,
      patternsAnalyzed: resolved.length,
      operationsIdentities: resolved.length,
      patternsMappedToAtLeastOneMonitoringSource: mapped.length,
      mappingCoveragePercentage: resolved.length ? Number((mapped.length / resolved.length * 100).toFixed(1)) : 0,
      sourceCounts,
      mappingConflicts: resolved.filter((item) => item.mappingConflict).length,
      locallyConfirmedMappings: decisions.filter((item) => item.decision === 'CONFIRMED_LOCAL').length,
      rejectedMappings: decisions.filter((item) => item.decision === 'REJECTED_LOCAL').length,
      inventory: { status: inventories.status, cacheTtlMs: config.cacheTtlMs },
      sourceDiscovery,
      rawPayloadFieldCoverage,
      performance: { executionTimeMs: Math.max(0, now() - startedAt), coldIndexBuildTimeMs: inventories.buildTimeMs, cacheHit: inventories.cacheHit === true },
      scoresChanged: false,
      externalMutations: 'none',
      aiUsed: false,
    };
    coverageCache.set(cacheKey, { cachedAtMs: now(), base, resolved });
    return {
      ...base,
      entities: resolved.slice(start, start + size).map((item) => ({ groupId: item.groupId, canonicalEntity: item.canonicalEntity, summary: item.summary, mappings: item.mappings, normalizedIdentities: item.normalizedIdentities, operationsIdentity: item.operationsIdentity, sourceDiscovery: item.sourceDiscovery, sourceDiscoveries: item.sourceDiscoveries, conflicts: item.conflicts })),
      pagination: { page, size, total: resolved.length, totalPages: Math.max(1, Math.ceil(resolved.length / size)) },
    };
  }

  async function review(entityId, action, payload = {}) {
    if (!/^[a-f0-9]{24}$/.test(String(entityId || ''))) throw safeError('A valid canonical entity ID is required.', 'INVALID_SOURCE_ENTITY_ID');
    if (!['confirm', 'reject'].includes(action)) throw safeError('Mapping action must be confirm or reject.', 'INVALID_SOURCE_MAPPING_ACTION');
    const resolution = await resolve({ groupId: payload.groupId, range: payload.range || '90d' });
    if (resolution.canonicalEntity.entityId !== entityId) throw safeError('The mapping decision does not belong to the selected canonical entity.', 'SOURCE_ENTITY_MISMATCH', 409);
    const source = cleanText(payload.source);
    const sourceEntityId = cleanText(payload.sourceEntityId);
    const candidates = Object.values(resolution.mappings).flatMap((value) => Array.isArray(value) ? value : []);
    const mapping = candidates.find((item) => item.source === source && item.sourceEntityId === sourceEntityId);
    if (!mapping) throw safeError('The selected deterministic mapping candidate was not found.', 'SOURCE_MAPPING_NOT_FOUND', 404);
    if (!REVIEWABLE_LEVELS.has(mapping.evidenceLevel || mapping.level)) throw safeError('Only Strong or Candidate mappings may be reviewed locally.', 'SOURCE_MAPPING_NOT_REVIEWABLE', 409);
    const decision = action === 'confirm' ? 'CONFIRMED_LOCAL' : 'REJECTED_LOCAL';
    const saved = await (await registry()).save(resolution.canonicalEntity, mapping, decision, cleanText(payload.confirmedBy) || null);
    coverageCache.clear();
    return { ...saved, localOnly: true, externalMutations: 'none', vendorMappingChanged: false };
  }

  async function getEntity(entityId, options = {}) {
    const requestedEntityId = String(entityId || '');
    if (!/^[a-f0-9]{24}$/.test(requestedEntityId)) {
      throw safeError('A valid canonical entity ID is required.', 'INVALID_SOURCE_ENTITY_ID');
    }

    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '90d';
    if (options.groupId) {
      const resolution = await resolve({ groupId: options.groupId, range, refresh: options.refresh === true });
      if (resolution.canonicalEntity.entityId !== requestedEntityId) {
        throw safeError('Canonical entity does not belong to the requested Operations pattern.', 'SOURCE_ENTITY_MISMATCH', 409);
      }
      return resolution;
    }

    const findCachedResolution = () => {
      const preferredKey = coverageKey(range, Boolean(discovery));
      const preferred = coverageCache.get(preferredKey);
      const entries = preferred
        ? [[preferredKey, preferred], ...[...coverageCache.entries()].filter(([key]) => key !== preferredKey)]
        : [...coverageCache.entries()];
      for (const [, cached] of entries) {
        if (!cached || now() - cached.cachedAtMs >= config.cacheTtlMs) continue;
        const resolution = cached.resolved.find((item) => item.canonicalEntity.entityId === requestedEntityId);
        if (resolution) {
          return {
            ...resolution,
            performance: {
              ...resolution.performance,
              cacheHit: true,
              resolutionSource: 'coverage_cache',
            },
          };
        }
      }
      return null;
    };

    const cachedResolution = findCachedResolution();
    if (cachedResolution) return cachedResolution;

    await getCoverage({ range, page: 1, size: 1, refresh: options.refresh === true });
    const resolvedAfterCoverage = findCachedResolution();
    if (resolvedAfterCoverage) return resolvedAfterCoverage;

    try {
      const entity = await (await registry()).getEntity(requestedEntityId);
      if (!entity) throw safeError('Canonical entity was not found in the local mapping registry.', 'SOURCE_IDENTITY_NOT_FOUND', 404);
      return { ...entity, externalMutations: 'none' };
    } catch (error) {
      if (error.code) throw error;
      throw safeError('The local mapping registry is unavailable.', 'SOURCE_IDENTITY_REGISTRY_UNAVAILABLE', 503);
    }
  }

  function clearCache() {
    inventoryCache = null;
    coverageCache.clear();
    if (discovery?.clearCache) discovery.clearCache();
  }

  return { clearCache, getCoverage, getEntity, getInventories, resolve, resolveGroup, review };
}

module.exports = {
  ACCEPTED_VALIDATION_LEVELS,
  ENTITY_TYPES,
  MAPPING_LEVELS,
  SOURCE_KEYS,
  appDynamicsMappings,
  createSourceIdentityService,
  detectConflicts,
  environmentDomain,
  environmentFromText,
  extractDeepLinkIdentity,
  extractOperationsIdentity,
  grafanaMappings,
  loadSourceInventories,
  nagiosMappings,
  normalizedIdentityTargets,
  normalizeEnvironment,
  normalizeIdentity,
  service: createSourceIdentityService({ discovery: sourceSideIdentityDiscoveryService }),
  thousandEyesMappings,
};
