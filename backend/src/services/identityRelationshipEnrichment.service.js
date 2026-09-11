const crypto = require('node:crypto');
const db = require('../config/db');
const { service: alertEpisodeService } = require('./alertEpisode.service');
const {
  createEpisodeCorrelationDiscoveryService,
  service: episodeCorrelationDiscoveryService,
} = require('./episodeCorrelationDiscovery.service');
const { extractRawOperationsIdentity } = require('./rawOperationsIdentity.service');
const { evaluateUnifiedEvidence } = require('./unifiedEvidenceDecision.service');
const { observationTechnicalEvidence } = require('./occurrenceEvidenceConsumption.service');

const POLICY = 'READ_ONLY_IDENTITY_RELATIONSHIP_ENRICHMENT_V1';
const QUALITY = Object.freeze({
  AUTHORITATIVE: 4,
  STRUCTURED: 3,
  SIGNATURE_FALLBACK: 2,
  UNRESOLVED: 1,
});
const SOURCE_NAMES = ['Grafana', 'AppDynamics', 'Nagios', 'ThousandEyes'];

function clean(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && clean(value))
    .map((value) => typeof value === 'string' ? clean(value) : value))];
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function canonicalSource(value) {
  const candidate = normalize(clean(value).split('|')[0]).replaceAll('-', '');
  if (['appd', 'appdynamics'].includes(candidate)) return 'AppDynamics';
  if (candidate === 'grafana') return 'Grafana';
  if (['nagios', 'nagiosxi', 'nagiosxiv2'].includes(candidate)) return 'Nagios';
  if (candidate === 'thousandeyes') return 'ThousandEyes';
  return null;
}

function safeJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function indexBy(rows, fields) {
  const result = new Map();
  rows.forEach((row) => fields.forEach((field) => {
    const key = normalize(row[field]);
    if (!key) return;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }));
  return result;
}

function exactUnique(index, values) {
  const matches = unique((values || []).flatMap((value) => index.get(normalize(value)) || []));
  return matches.length === 1 ? matches[0] : null;
}

function provenanceFor(extraction, field, value) {
  return (extraction?.provenance || []).filter((item) => item.field === field && clean(item.value) === clean(value));
}

function resolved(value, source, method, confidence, authority, provenance = []) {
  if (value === null || value === undefined || !clean(value)) return null;
  if (typeof value === 'string' && /^(unknown|unknown-service|unknown-application|unresolved|unassigned|none|null|n\/a|not available)$/i.test(clean(value))) return null;
  if (typeof value === 'string' && /^(?:latest-?event-?)?(?:application|tier|node|business-transaction|health-rule|policy|event|violation|service|host)-(?:id|name)$/i.test(normalize(value))) return null;
  return {
    value: typeof value === 'string' ? clean(value) : value,
    source,
    resolutionMethod: method,
    confidence,
    authority,
    provenance,
  };
}

function extractedValues(extractions, field) {
  return unique(extractions.flatMap((item) => item.extracted?.[field] || []));
}

function strongestField(candidates) {
  return (candidates || []).filter(Boolean).sort((left, right) => (
    (QUALITY[right.authority] || 0) - (QUALITY[left.authority] || 0)
      || Number(right.confidence || 0) - Number(left.confidence || 0)
  ))[0] || null;
}

function componentValues(episode, namespaces) {
  return (episode.fingerprintComponents?.entity || []).flatMap((component) => {
    const separator = clean(component).indexOf(':');
    const namespace = separator >= 0 ? normalize(clean(component).slice(0, separator)) : null;
    const value = separator >= 0 ? clean(component).slice(separator + 1) : clean(component);
    return namespaces.includes(namespace) && value ? [value] : [];
  });
}

function baseQuality(episode) {
  if (episode.fingerprintStrength === 'AUTHORITATIVE_SOURCE_IDENTITY') return 'AUTHORITATIVE';
  if (episode.fingerprintStrength === 'STRUCTURED_SOURCE_IDENTITY') return 'STRUCTURED';
  if (episode.fingerprintStrength === 'SIGNATURE_FALLBACK') return 'SIGNATURE_FALLBACK';
  return 'UNRESOLVED';
}

function qualityFromFields(fields, extractionConflicts = []) {
  const conflictFields = {
    applicationIds: ['applicationId'], applicationNames: ['application'], tierIds: ['tierId'],
    tierNames: ['tier'], nodeIds: ['nodeId'], nodeNames: ['node'],
    businessTransactionIds: ['businessTransactionId'], businessTransactionNames: ['businessTransaction'],
    healthRuleIds: ['healthRuleId'], healthRuleNames: ['healthRule'], policyIds: ['policyId'],
    eventIds: ['eventId'], violationIds: ['violationId'], ruleUids: ['ruleUid'],
    dashboardUids: ['dashboardUid'], panelIds: ['panelId'], hostNames: ['host'],
    serviceNames: ['service'], environmentNames: ['environment'], instances: ['instance', 'controller'],
  };
  const relevantConflict = extractionConflicts.some((conflict) => (
    (conflictFields[conflict.field] || []).some((field) => Boolean(fields[field]))
  ));
  if (relevantConflict) return 'UNRESOLVED';
  const authorities = Object.values(fields).filter(Boolean).map((field) => field.authority);
  if (authorities.includes('AUTHORITATIVE')) return 'AUTHORITATIVE';
  if (authorities.includes('STRUCTURED')) return 'STRUCTURED';
  if (authorities.includes('SIGNATURE_FALLBACK')) return 'SIGNATURE_FALLBACK';
  return 'UNRESOLVED';
}

function inventoryIndexes(inventory) {
  return {
    grafanaRulesByUid: indexBy(inventory.grafanaRules, ['uid', 'rule_id']),
    grafanaRulesByName: indexBy(inventory.grafanaRules, ['title']),
    grafanaDashboards: indexBy(inventory.grafanaDashboards, ['uid']),
    grafanaPanels: indexBy(inventory.grafanaPanels, ['panel_id', 'panel_uid']),
    grafanaOccurrencesByAlert: indexBy(inventory.grafanaOccurrences || [], ['alert_id']),
    appApplications: indexBy(inventory.appApplications, ['application_id', 'application_name']),
    appTiers: indexBy(inventory.appTiers, ['tier_id', 'tier_name']),
    appNodes: indexBy(inventory.appNodes, ['node_id', 'node_name']),
    appTransactions: indexBy(inventory.appTransactions, ['business_transaction_id', 'business_transaction_name']),
    appRules: indexBy(inventory.appRules, ['health_rule_id', 'health_rule_name']),
    appPolicies: indexBy(inventory.appPolicies || [], ['policy_id', 'policy_name']),
    appEvents: indexBy(inventory.appEvents, ['event_id']),
    appOccurrencesByAlert: indexBy(inventory.appOccurrences || [], ['alert_id']),
    nagiosOccurrencesByAlert: indexBy(inventory.nagiosOccurrences || [], ['alert_id']),
    nagiosHosts: indexBy(inventory.nagiosHosts, ['host_name', 'entity_id']),
    nagiosServices: indexBy(inventory.nagiosServices, ['service_name', 'entity_id']),
  };
}

function labelValue(labels, names) {
  const value = safeJson(labels, {});
  const entries = Object.entries(value || {});
  for (const name of names) {
    const match = entries.find(([key]) => normalize(key) === normalize(name));
    if (match && clean(match[1])) return match[1];
  }
  return null;
}

function resolveGrafana(episode, extractions, indexes) {
  const occurrenceRows = unique((episode.alertIds || []).flatMap((alertId) => (
    indexes.grafanaOccurrencesByAlert.get(normalize(alertId)) || []
  ))).filter((row) => row.source_resolved === true);
  const occurrenceValue = (field) => {
    const candidates = occurrenceRows.map((row) => row[field]).filter(Boolean);
    const values = new Map(candidates.map((value) => {
      const normalizedValue = value instanceof Date ? value.toISOString() : value;
      const key = normalizedValue && typeof normalizedValue === 'object'
        ? JSON.stringify(normalizedValue) : clean(normalizedValue);
      return [key, normalizedValue];
    }));
    return values.size === 1 ? [...values.values()][0] : null;
  };
  const occurrenceField = (field, label) => {
    const value = occurrenceValue(field);
    if (!value) return null;
    const quality = occurrenceValue('identity_quality') === 'AUTHORITATIVE' ? 'AUTHORITATIVE' : 'STRUCTURED';
    return resolved(value, 'Grafana read-only occurrence reconciliation', 'exactRuleInstanceOccurrence',
      quality === 'AUTHORITATIVE' ? 100 : 95, quality,
      occurrenceRows.filter((row) => clean(row[field]) === clean(value)).map((row) => ({
        alertId: row.alert_id,
        sourceOccurrenceId: row.source_occurrence_id,
        evidence: label,
      })));
  };
  const occurrenceRuleUid = occurrenceValue('rule_uid');
  const ruleUids = unique([occurrenceRuleUid, ...extractedValues(extractions, 'ruleUids')]);
  const ruleNames = extractedValues(extractions, 'ruleNames');
  const dashboardUids = extractedValues(extractions, 'dashboardUids');
  const panelIds = extractedValues(extractions, 'panelIds');
  const rule = exactUnique(indexes.grafanaRulesByUid, ruleUids)
    || exactUnique(indexes.grafanaRulesByName, ruleNames);
  const occurrenceAuthority = occurrenceRuleUid
    ? occurrenceValue('identity_quality') === 'AUTHORITATIVE' ? 'AUTHORITATIVE' : 'STRUCTURED'
    : null;
  const ruleAuthority = rule && occurrenceAuthority ? occurrenceAuthority
    : rule && ruleUids.some((value) => [rule.uid, rule.rule_id].map(normalize).includes(normalize(value)))
      ? 'AUTHORITATIVE' : rule ? 'STRUCTURED' : null;
  const ruleConfidence = ruleAuthority === 'AUTHORITATIVE' ? 100 : 92;
  const dashboardUid = rule?.dashboard_uid || dashboardUids[0] || null;
  const panelId = rule?.panel_id || panelIds[0] || null;
  const dashboard = exactUnique(indexes.grafanaDashboards, [dashboardUid]);
  const panelCandidates = (indexes.grafanaPanels.get(normalize(panelId)) || [])
    .filter((item) => !dashboardUid || normalize(item.dashboard_uid) === normalize(dashboardUid));
  const panel = panelCandidates.length === 1 ? panelCandidates[0] : null;
  const occurrenceLabels = safeJson(occurrenceValue('instance_labels'), {});
  const labels = { ...(rule?.labels || {}), ...occurrenceLabels };
  const fields = {
    ruleUid: occurrenceField('rule_uid', 'Exact Grafana rule UID and instance lifecycle') || (rule ? resolved(rule.uid, 'Grafana stored alert-rule inventory', ruleAuthority === 'AUTHORITATIVE' ? 'ruleUid' : 'exactStructuredRuleName', ruleConfidence, ruleAuthority,
      extractions.flatMap((item) => provenanceFor(item, ruleAuthority === 'AUTHORITATIVE' ? 'ruleUids' : 'ruleNames', ruleAuthority === 'AUTHORITATIVE' ? rule.uid : rule.title)))
      : ruleUids.length === 1 ? resolved(ruleUids[0], 'JSM Operations / stored alert payload', 'ruleUid', 100, 'AUTHORITATIVE') : null),
    ruleName: occurrenceField('rule_name', 'Exact Grafana rule-instance occurrence')
      || (rule ? resolved(rule.title, 'Grafana stored alert-rule inventory', 'ruleUidInventoryJoin', ruleConfidence, ruleAuthority) : null),
    alertRule: rule ? resolved(rule.title, 'Grafana stored alert-rule inventory', 'ruleUidInventoryJoin', ruleConfidence, ruleAuthority) : null,
    labels: rule && Object.keys(labels).length ? resolved(labels, 'Grafana stored alert-rule inventory', 'ruleUidInventoryJoin', ruleConfidence, ruleAuthority) : null,
    annotations: rule && Object.keys(rule.annotations || {}).length
      ? resolved(rule.annotations, 'Grafana stored alert-rule inventory', 'ruleUidInventoryJoin', ruleConfidence, ruleAuthority) : null,
    folder: rule?.folder_name ? resolved(rule.folder_name, 'Grafana stored alert-rule inventory', 'ruleUidInventoryJoin', ruleConfidence, ruleAuthority) : null,
    dashboardUid: dashboardUid ? resolved(dashboardUid, rule ? 'Grafana stored alert-rule inventory' : 'JSM Operations / stored alert payload', rule ? 'ruleUidInventoryJoin' : 'dashboardUid', rule ? ruleConfidence : 100, rule ? ruleAuthority : 'AUTHORITATIVE') : null,
    dashboard: dashboard?.title ? resolved(dashboard.title, 'Grafana stored dashboard inventory', 'dashboardUidInventoryJoin', 100, 'AUTHORITATIVE') : null,
    panelId: panelId ? resolved(panelId, rule ? 'Grafana stored alert-rule inventory' : 'JSM Operations / stored alert payload', rule ? 'ruleUidInventoryJoin' : 'panelId', rule ? ruleConfidence : 100, rule ? ruleAuthority : 'AUTHORITATIVE') : null,
    panel: panel?.panel_title ? resolved(panel.panel_title, 'Grafana stored panel inventory', 'dashboardUidAndPanelId', 100, 'AUTHORITATIVE') : null,
    datasource: panel?.datasource_name ? resolved(panel.datasource_name, 'Grafana stored panel inventory', 'dashboardUidAndPanelId', 100, 'AUTHORITATIVE') : null,
    application: null,
    service: null,
    environment: null,
    cluster: null,
    namespace: null,
    pod: null,
    host: null,
    database: null,
    team: null,
    sourceAlertIdentifier: null,
    sourceOccurrenceId: occurrenceField('source_occurrence_id', 'Exact Grafana source occurrence'),
    fingerprint: occurrenceField('fingerprint', 'Grafana rule-instance fingerprint'),
    occurrenceState: occurrenceField('occurrence_state', 'Grafana firing transition'),
    currentState: occurrenceField('current_state', 'Grafana current/recovery lifecycle'),
    firingAt: occurrenceField('firing_at', 'Grafana same-instance firing transition'),
    recoveryAt: occurrenceField('recovery_at', 'Grafana same-instance recovery transition'),
  };
  const structuredLabels = {
    application: ['application', 'app'], service: ['service'], environment: ['environment', 'env'],
    cluster: ['cluster'], namespace: ['namespace'], pod: ['pod'], host: ['host', 'instance'],
    database: ['database', 'db'], team: ['team', 'owner'],
  };
  Object.entries(structuredLabels).forEach(([field, names]) => {
    const value = labelValue(labels, names);
    if (value) fields[field] = resolved(value,
      occurrenceLabels && Object.keys(occurrenceLabels).length
        ? 'Grafana exact rule-instance occurrence labels' : 'Grafana stored alert-rule labels',
      `label:${names[0]}`, 95, 'STRUCTURED');
  });
  const sourceIds = extractedValues(extractions, 'sourceEntityIds');
  if (sourceIds.length === 1) fields.sourceAlertIdentifier = resolved(sourceIds[0], 'JSM Operations / stored alert payload', 'sourceEntityId', 100, 'AUTHORITATIVE');
  return fields;
}

function resolveAppDynamics(episode, extractions, indexes, inventory) {
  const values = (field) => extractedValues(extractions, field);
  const occurrenceRows = unique((episode.alertIds || []).flatMap((alertId) => (
    indexes.appOccurrencesByAlert.get(normalize(alertId)) || []
  ))).filter((row) => row.source_resolved === true);
  const occurrenceValue = (field) => {
    const candidates = unique(occurrenceRows.map((row) => row[field]).filter(Boolean));
    if (candidates.length !== 1) return null;
    return candidates[0] instanceof Date ? candidates[0].toISOString() : candidates[0];
  };
  const occurrenceField = (field, label, method = 'exactOccurrenceEvidence') => {
    const value = occurrenceValue(field);
    return value ? resolved(value, 'AppDynamics read-only occurrence reconciliation', method, 100, 'AUTHORITATIVE',
      occurrenceRows.filter((row) => clean(row[field]) === clean(value)).map((row) => ({
        alertId: row.alert_id,
        sourceOccurrenceId: row.source_occurrence_id,
        evidence: label,
      }))) : null;
  };
  const applicationReferences = [
    ...values('applicationIds'), ...values('applicationNames'),
    ...occurrenceRows.flatMap((row) => [row.application_id, row.application_name]).filter(Boolean),
  ];
  const application = exactUnique(indexes.appApplications, applicationReferences);
  const validatedApplicationMappings = inventory.mappings.filter((mapping) => (
    canonicalSource(mapping.source_system) === 'AppDynamics'
      && applicationReferences.some((value) => [mapping.source_entity_id, mapping.source_entity_name]
        .map(normalize).includes(normalize(value)))
  ));
  const mappedEntityIds = unique(validatedApplicationMappings.map((mapping) => mapping.entity_id));
  const validatedApplication = mappedEntityIds.length === 1 ? validatedApplicationMappings[0] : null;
  const tier = exactUnique(indexes.appTiers, [...values('tierIds'), ...values('tierNames')]);
  const node = exactUnique(indexes.appNodes, [...values('nodeIds'), ...values('nodeNames')]);
  const transaction = exactUnique(indexes.appTransactions, [...values('businessTransactionIds'), ...values('businessTransactionNames')]);
  const rule = exactUnique(indexes.appRules, [...values('healthRuleIds'), ...values('healthRuleNames'),
    ...occurrenceRows.flatMap((row) => [row.health_rule_id, row.health_rule_name]).filter(Boolean)]);
  const policy = exactUnique(indexes.appPolicies, [...values('policyIds'), ...values('policyNames'),
    ...occurrenceRows.flatMap((row) => [row.policy_id, row.policy_name]).filter(Boolean)]);
  const event = exactUnique(indexes.appEvents, [...values('eventIds'), ...occurrenceRows.map((row) => row.event_id).filter(Boolean)]);
  const direct = (field, method, authority = 'AUTHORITATIVE') => {
    const candidates = values(field);
    return candidates.length === 1 ? resolved(candidates[0], 'JSM Operations / stored AppDynamics payload', method, authority === 'AUTHORITATIVE' ? 100 : 90, authority) : null;
  };
  const numericApplicationReferences = applicationReferences.filter((value) => /^\d+$/.test(clean(value)));
  const namedApplicationReferences = values('applicationNames').filter((value) => !/^\d+$/.test(clean(value)));
  const tierEnvironmentValues = values('tierNames').filter((value) => /^(prod|production|dev|development|qa|test|stage|staging|nonprod|non-production)$/i.test(clean(value)));
  const tierIdentityValues = values('tierNames').filter((value) => !tierEnvironmentValues.includes(value));
  const applicationId = application?.application_id || validatedApplication?.source_entity_id
    || values('applicationIds')[0] || numericApplicationReferences[0] || null;
  const topology = inventory.appFlow.filter((item) => !applicationId || clean(item.application_id) === clean(applicationId));
  const backendTopology = topology.filter((item) => (
    ['backend-dependency', 'database-dependency'].includes(normalize(item.entity_type))
  ));
  const databaseTopology = topology.filter((item) => normalize(item.entity_type) === 'database-dependency');
  return {
    controller: extractedValues(extractions, 'instances').length === 1
      ? resolved(extractedValues(extractions, 'instances')[0], 'Stored AppDynamics deep link', 'controllerHost', 100, 'AUTHORITATIVE') : null,
    applicationId: application ? resolved(application.application_id, 'AppDynamics stored application inventory', 'applicationId', 100, 'AUTHORITATIVE')
      : validatedApplication ? resolved(validatedApplication.source_entity_id, 'Validated source identity registry', 'validatedApplicationMapping', validatedApplication.confidence_score, validatedApplication.evidence_level === 'EXACT' ? 'AUTHORITATIVE' : 'STRUCTURED')
        : applicationId ? resolved(applicationId, 'JSM Operations / stored AppDynamics payload', 'structuredApplicationReference', 90, 'STRUCTURED') : null,
    application: application ? resolved(application.application_name, 'AppDynamics stored application inventory', 'applicationIdInventoryJoin', 100, 'AUTHORITATIVE')
      : validatedApplication?.canonical_name ? resolved(validatedApplication.canonical_name, 'Validated source identity registry', 'validatedApplicationMapping', validatedApplication.confidence_score, validatedApplication.evidence_level === 'EXACT' ? 'AUTHORITATIVE' : 'STRUCTURED')
        : namedApplicationReferences.length === 1 ? resolved(namedApplicationReferences[0], 'JSM Operations / stored AppDynamics payload', 'structuredApplicationName', 90, 'STRUCTURED') : null,
    sourceOccurrenceId: occurrenceField('source_occurrence_id', 'Source occurrence ID'),
    tierId: occurrenceField('tier_id', 'Tier ID')
      || (tier ? resolved(tier.tier_id, 'AppDynamics stored tier inventory', 'tierId', 100, 'AUTHORITATIVE') : direct('tierIds', 'tierId')),
    tier: occurrenceField('tier_name', 'Tier') || (tier ? resolved(tier.tier_name, 'AppDynamics stored tier inventory', 'tierIdInventoryJoin', 100, 'AUTHORITATIVE')
      : tierIdentityValues.length === 1 ? resolved(tierIdentityValues[0], 'JSM Operations / stored alert payload', 'structuredTierName', 90, 'STRUCTURED') : null),
    nodeId: occurrenceField('node_id', 'Node ID') || (node ? resolved(node.node_id, 'AppDynamics stored node inventory', 'nodeId', 100, 'AUTHORITATIVE') : direct('nodeIds', 'nodeId')),
    node: occurrenceField('node_name', 'Node') || (node ? resolved(node.node_name, 'AppDynamics stored node inventory', 'nodeIdInventoryJoin', 100, 'AUTHORITATIVE') : direct('nodeNames', 'structuredNodeName', 'STRUCTURED')),
    businessTransactionId: occurrenceField('business_transaction_id', 'Business transaction ID') || (transaction ? resolved(transaction.business_transaction_id, 'AppDynamics stored transaction inventory', 'businessTransactionId', 100, 'AUTHORITATIVE') : direct('businessTransactionIds', 'businessTransactionId')),
    businessTransaction: occurrenceField('business_transaction_name', 'Business transaction') || (transaction ? resolved(transaction.business_transaction_name, 'AppDynamics stored transaction inventory', 'businessTransactionIdInventoryJoin', 100, 'AUTHORITATIVE') : direct('businessTransactionNames', 'structuredBusinessTransactionName', 'STRUCTURED')),
    healthRuleId: occurrenceField('health_rule_id', 'Health rule ID') || (rule ? resolved(rule.health_rule_id, 'AppDynamics stored health-rule inventory', 'healthRuleId', 100, 'AUTHORITATIVE') : direct('healthRuleIds', 'healthRuleId')),
    healthRule: occurrenceField('health_rule_name', 'Health rule') || (rule ? resolved(rule.health_rule_name, 'AppDynamics stored health-rule inventory', 'healthRuleIdInventoryJoin', 100, 'AUTHORITATIVE') : direct('healthRuleNames', 'structuredHealthRuleName', 'STRUCTURED')),
    policyId: occurrenceField('policy_id', 'Policy ID') || (policy ? resolved(policy.policy_id, 'AppDynamics stored policy inventory', 'policyId', 100, 'AUTHORITATIVE') : direct('policyIds', 'policyId')),
    policy: occurrenceField('policy_name', 'Policy') || (policy ? resolved(policy.policy_name, 'AppDynamics stored policy inventory', 'policyIdInventoryJoin', 100, 'AUTHORITATIVE') : direct('policyNames', 'structuredPolicyName', 'STRUCTURED')),
    eventId: occurrenceField('event_id', 'Event ID') || (event ? resolved(event.event_id, 'AppDynamics stored event inventory', 'eventId', 100, 'AUTHORITATIVE') : direct('eventIds', 'eventId')),
    violationId: occurrenceField('violation_id', 'Violation ID') || direct('violationIds', 'violationId'),
    occurrenceState: occurrenceField('occurrence_state', 'Occurrence state'),
    currentState: occurrenceField('current_state', 'Current source state'),
    firingAt: occurrenceField('firing_at', 'Firing timestamp'),
    recoveryAt: occurrenceField('recovery_at', 'Recovery timestamp'),
    affectedEntity: occurrenceField('affected_entity', 'Affected entity'),
    sourceDeepLink: occurrenceField('deep_link', 'Source deep link'),
    backendDependency: backendTopology.length ? resolved(backendTopology.map((item) => ({
      entityId: item.entity_id, entityType: item.entity_type, entityName: item.entity_name,
      sourceEntityId: item.source_entity_id, targetEntityId: item.target_entity_id,
    })), 'AppDynamics stored flow-map inventory', 'applicationIdTopologyJoin', 100, 'AUTHORITATIVE') : null,
    databaseDependency: databaseTopology.length
      ? resolved(databaseTopology.map((item) => item.entity_name), 'AppDynamics stored flow-map inventory', 'applicationIdTopologyJoin', 100, 'AUTHORITATIVE') : null,
    environment: direct('environmentNames', 'structuredEnvironment', 'STRUCTURED')
      || (tierEnvironmentValues.length === 1 ? resolved(tierEnvironmentValues[0], 'JSM Operations / stored AppDynamics payload', 'tierEnvironment', 90, 'STRUCTURED') : null),
  };
}

function resolveNagios(episode, extractions, indexes) {
  const occurrenceRows = unique((episode.alertIds || []).flatMap((alertId) => (
    indexes.nagiosOccurrencesByAlert.get(normalize(alertId)) || []
  ))).filter((row) => row.source_resolved === true);
  const occurrenceValue = (field) => {
    const values = new Map(occurrenceRows.map((row) => row[field]).filter((value) => (
      value !== null && value !== undefined && value !== ''
    )).map((value) => {
      const normalizedValue = value instanceof Date ? value.toISOString() : value;
      const key = normalizedValue && typeof normalizedValue === 'object'
        ? JSON.stringify(normalizedValue) : clean(normalizedValue);
      return [key, normalizedValue];
    }));
    return values.size === 1 ? [...values.values()][0] : null;
  };
  const occurrenceField = (field, label) => {
    const value = occurrenceValue(field);
    if (value === null || value === undefined || value === '') return null;
    return resolved(value, 'Nagios XI read-only occurrence reconciliation',
      'exactInstanceHostServiceOccurrence', 100, 'AUTHORITATIVE',
      occurrenceRows.filter((row) => clean(row[field]) === clean(value)).map((row) => ({
        alertId: row.alert_id, sourceOccurrenceId: row.source_occurrence_id, evidence: label,
      })));
  };
  const templateMatches = (episode.members || []).map((member) => (
    clean(member.title).match(/^\[Nagios\]\s+(.+?)\s+on\s+(\S+)\s+is\s+/i)
  )).filter(Boolean);
  const templateHosts = unique([occurrenceValue('host_name'), ...templateMatches.map((match) => match[2])]);
  const templateServices = unique([occurrenceValue('service_description'), ...templateMatches.map((match) => match[1])]);
  const hosts = unique([...extractedValues(extractions, 'hostNames'), ...componentValues(episode, ['host']), ...templateHosts]);
  const services = unique([...extractedValues(extractions, 'serviceNames'), ...componentValues(episode, ['service']), ...templateServices]);
  const instances = unique([occurrenceValue('source_instance'), ...extractedValues(extractions, 'instances'), ...componentValues(episode, ['instance'])]);
  const hostRows = hosts.flatMap((host) => indexes.nagiosHosts.get(normalize(host)) || []);
  const serviceRows = services.flatMap((service) => indexes.nagiosServices.get(normalize(service)) || [])
    .filter((row) => !hosts.length || hosts.map(normalize).includes(normalize(row.host_name)));
  const narrowedHosts = instances.length ? hostRows.filter((row) => instances.map(normalize).includes(normalize(row.source_instance))) : hostRows;
  const narrowedServices = instances.length ? serviceRows.filter((row) => instances.map(normalize).includes(normalize(row.source_instance))) : serviceRows;
  const host = unique(narrowedHosts.length ? narrowedHosts : hostRows);
  const service = unique(narrowedServices.length ? narrowedServices : serviceRows);
  const hostName = hosts.length === 1 ? hosts[0] : service.length === 1 ? service[0].host_name
    : host.length === 1 ? host[0].host_name : null;
  const serviceName = services.length === 1 ? services[0] : service.length === 1 ? service[0].service_name : null;
  const row = service.length === 1 ? service[0] : host.length === 1 ? host[0] : null;
  const sourceInstance = instances.length === 1 ? instances[0] : row?.source_instance || null;
  const authoritative = hostName && (host.length || service.length);
  const authority = authoritative ? 'AUTHORITATIVE' : hostName ? 'STRUCTURED' : null;
  const confidence = authoritative ? 100 : 90;
  return {
    instance: occurrenceField('source_instance', 'Exact Nagios instance')
      || (sourceInstance ? resolved(sourceInstance, row ? 'Nagios stored host/service inventory' : 'JSM Operations / stored Nagios payload', row ? 'exactHostServiceInventoryJoin' : 'structuredInstance', confidence, authority || 'STRUCTURED') : null),
    host: occurrenceField('host_name', 'Exact Nagios host')
      || (hostName ? resolved(hostName, row ? 'Nagios stored host/service inventory' : 'JSM Operations / stored Nagios payload', row ? 'exactHostInventoryJoin' : templateHosts.includes(hostName) ? 'nagiosAlertTemplateHost' : 'structuredHostName', confidence, authority || 'STRUCTURED') : null),
    service: occurrenceField('service_description', 'Exact Nagios service')
      || (serviceName ? resolved(serviceName, row ? 'Nagios stored service inventory' : 'JSM Operations / stored Nagios payload', row ? 'exactHostServiceInventoryJoin' : templateServices.includes(serviceName) ? 'nagiosAlertTemplateService' : 'structuredServiceName', confidence, authority || 'STRUCTURED') : null),
    canonicalKey: occurrenceField('canonical_identity', 'Canonical Nagios instance/host/service identity')
      || (hostName ? resolved([sourceInstance, hostName, serviceName].filter(Boolean).join(':'), 'Derived from exact Nagios identity fields', 'instanceHostServiceKey', confidence, authority || 'STRUCTURED') : null),
    environment: sourceInstance ? resolved(sourceInstance, 'Nagios stored source instance', 'sourceInstance', confidence, authority || 'STRUCTURED') : null,
    application: null,
    applicationServiceMapping: null,
    pluginCheck: serviceName ? resolved(serviceName, 'Nagios stored service identity', 'serviceCheckIdentity', confidence, authority || 'STRUCTURED') : null,
    sourceEntityId: occurrenceField('object_id', 'Nagios source object ID'),
    sourceOccurrenceId: occurrenceField('source_occurrence_id', 'Exact Nagios source occurrence'),
    occurrenceState: occurrenceField('occurrence_state', 'Nagios firing state'),
    currentState: occurrenceField('current_state', 'Nagios occurrence lifecycle state'),
    sourceCurrentState: occurrenceField('current_source_state', 'Nagios current host/service state'),
    state: occurrenceField('current_source_state', 'Nagios current host/service state')
      || (row?.status ? resolved(row.status, 'Nagios stored host/service inventory', 'exactHostServiceInventoryJoin', 100, 'AUTHORITATIVE') : null),
    stateType: occurrenceField('occurrence_state_type', 'Nagios occurrence state type')
      || (row?.state_type ? resolved(row.state_type, 'Nagios stored host/service inventory', 'exactHostServiceInventoryJoin', 100, 'AUTHORITATIVE') : null),
    stateTimestamp: occurrenceField('last_state_change', 'Nagios last state change')
      || (row?.last_state_change ? resolved(row.last_state_change, 'Nagios stored host/service inventory', 'exactHostServiceInventoryJoin', 100, 'AUTHORITATIVE') : null),
    firingAt: occurrenceField('firing_at', 'Nagios authoritative problem transition'),
    recoveryAt: occurrenceField('recovery_at', 'Nagios authoritative same-identity OK transition'),
    lastCheck: occurrenceField('last_check', 'Nagios last check'),
    nextCheck: occurrenceField('next_check', 'Nagios next check'),
    recoveryAuthoritative: occurrenceField('recovery_authoritative', 'Nagios recovery contract'),
    acknowledged: occurrenceField('acknowledged', 'Nagios acknowledgement state'),
    downtime: occurrenceField('downtime', 'Nagios scheduled downtime state'),
    notificationState: occurrenceField('notifications_enabled', 'Nagios notification state'),
    pluginOutput: occurrenceField('plugin_output', 'Nagios occurrence plugin output')
      || (row?.output ? resolved(row.output, 'Nagios stored host/service inventory', 'exactHostServiceInventoryJoin', 100, 'AUTHORITATIVE') : null),
  };
}

function exactToken(value, candidates) {
  const text = JSON.stringify(value || {});
  return candidates.find((candidate) => new RegExp(`(^|[^0-9A-Za-z])${clean(candidate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z]|$)`, 'i').test(text)) || null;
}

function relationshipSummary(episode, alertsById, slackByNumber, jiraByAlert, jiraCandidates) {
  const tinyIds = unique((episode.members || []).map((item) => clean(item.tinyId).replace(/^#/, '')));
  const slackRows = tinyIds.flatMap((tinyId) => slackByNumber.get(tinyId) || []);
  const messages = slackRows.map((row) => ({
    messageId: row.source_message_ts,
    channelId: row.slack_channel_id,
    channel: row.slack_channel_name || null,
    threadTimestamp: row.thread_ts || null,
    parentMessage: row.parent_message_ts || null,
    replyCount: Number(row.reply_count || 0),
    acknowledgement: /acknowledged/i.test(clean(row.status)) ? true : null,
    responder: row.responder || null,
    alertIdInMessage: row.alert_number,
    alertLink: (safeJson(row.links, []) || []).find((link) => /atlassian|opsgenie|jira/i.test(clean(link))) || null,
    sourceDeepLink: (safeJson(row.links, []) || []).find((link) => !/atlassian|opsgenie|jira|slack/i.test(clean(link))) || null,
    permalink: row.slack_permalink || null,
    provenance: 'EXACT_ALERT_NUMBER_IN_STORED_SLACK_EVENT',
  }));
  const slack = messages.length ? {
    relationship: 'STRUCTURED_RELATIONSHIP',
    resolutionMethod: 'exactAlertNumber',
    confidence: 100,
    messages,
    repeatedNotificationRelationship: messages.length > 1 ? {
      count: messages.length,
      messageIds: unique(messages.map((item) => item.messageId)),
    } : null,
  } : { relationship: 'NO_RELATIONSHIP_FOUND', messages: [] };

  const relations = episode.alertIds.flatMap((alertId) => jiraByAlert.get(alertId) || []);
  const candidates = episode.alertIds.flatMap((alertId) => jiraCandidates.get(alertId) || []);
  const confirmed = relations.filter((item) => item.relationship === 'CONFIRMED_RELATIONSHIP');
  const candidate = [...relations.filter((item) => item.relationship === 'CANDIDATE_RELATIONSHIP'), ...candidates];
  const jira = confirmed.length ? {
    relationship: 'CONFIRMED_RELATIONSHIP',
    incidents: confirmed,
  } : candidate.length ? {
    relationship: 'CANDIDATE_RELATIONSHIP',
    incidents: candidate,
  } : { relationship: 'NO_RELATIONSHIP_FOUND', incidents: [] };
  return { slack, jira };
}

function enhanceEpisode(episode, enrichment) {
  const fields = enrichment.fieldsUsableForIdentity ? enrichment.fields : {};
  const values = (...names) => names.map((name) => fields[name]?.value).filter(Boolean);
  const entity = unique([
    ...values('applicationId').map((value) => `application-id:${normalize(value)}`),
    ...values('application').map((value) => `application:${normalize(value)}`),
    ...values('service').map((value) => `service:${normalize(value)}`),
    ...values('tier').map((value) => `tier:${normalize(value)}`),
    ...values('node').map((value) => `node:${normalize(value)}`),
    ...values('host').map((value) => `host:${normalize(value)}`),
    ...values('instance').map((value) => `instance:${normalize(value)}`),
    ...(episode.fingerprintComponents?.entity || []),
  ]);
  const rules = unique([
    ...values('ruleUid').map((value) => `rule-uid:${normalize(value)}`),
    ...values('healthRule').map((value) => `health-rule:${normalize(value)}`),
    ...values('eventId').map((value) => `event:${normalize(value)}`),
    ...values('violationId').map((value) => `violation:${normalize(value)}`),
    ...values('sourceOccurrenceId').map((value) => `source-occurrence:${normalize(value)}`),
    ...values('pluginCheck').map((value) => `check:${normalize(value)}`),
    ...(episode.fingerprintComponents?.ruleEvent || []),
  ]);
  const canonicalEntity = values('application', 'service', 'host', 'node', 'tier').map(clean).join(' / ')
    || episode.canonicalEntity;
  return {
    ...episode,
    // Grouping keys and episode IDs deliberately remain untouched.
    fingerprintStrength: enrichment.identityQuality === 'AUTHORITATIVE'
      ? 'AUTHORITATIVE_SOURCE_IDENTITY'
      : enrichment.identityQuality === 'STRUCTURED' ? 'STRUCTURED_SOURCE_IDENTITY'
        : enrichment.identityQuality === 'SIGNATURE_FALLBACK' ? 'SIGNATURE_FALLBACK' : 'AMBIGUOUS',
    fingerprintComponents: { ...episode.fingerprintComponents, entity, ruleEvent: rules },
    canonicalEntity,
  };
}

function addRegistryEntry(registry, episode, field, canonicalField, provenance) {
  if (!field?.value || !canonicalField?.value || !['AUTHORITATIVE', 'STRUCTURED'].includes(field.authority)) return;
  const key = [episode.source, field.value, canonicalField.value].map(normalize).join('|');
  if (registry.has(key)) return;
  registry.set(key, {
    entity_id: `derived:${hash(normalize(canonicalField.value), 32)}`,
    source_system: episode.source,
    source_entity_id: clean(field.value),
    source_entity_name: clean(field.value),
    source_entity_type: 'READ_ONLY_DERIVED_IDENTITY',
    environment: null,
    confidence_score: Math.min(Number(field.confidence || 0), Number(canonicalField.confidence || 0)),
    mapping_mechanism: 'PROVENANCE_BACKED_STORED_EVIDENCE',
    provenance,
    persisted: false,
  });
}

function decisionName(value) {
  return clean(value).toUpperCase() === 'NEEDS_REVIEW' ? 'REVIEW' : clean(value).toUpperCase() || 'REVIEW';
}

function replayRecord(row, episode, enrichment, correlation) {
  const snapshot = row.feature_snapshot || {};
  const current = snapshot.currentBehavior || {};
  const historical = snapshot.historicalContext || {};
  const identity = snapshot.identity || {};
  const usableFields = enrichment.fieldsUsableForIdentity === false ? {} : enrichment.fields;
  const fieldValue = (...names) => names.map((name) => usableFields[name]?.value).find(Boolean) || null;
  const observed = row.noise_detection?.detectors || {};
  const observedBehavior = {};
  Object.entries({ duplicate: 'DUPLICATE', repeated: 'REPEAT', flapping: 'FLAPPING', autoResolved: 'AUTO_RESOLVED', nonActionable: 'NON_ACTIONABLE', correlated: 'CORRELATED', stale: 'STALE', expectedActivity: 'EXPECTED_ACTIVITY' })
    .forEach(([key, type]) => {
      const detector = observed[type];
      observedBehavior[key] = {
        state: detector?.observed === true ? 'OBSERVED' : 'NOT_OBSERVED',
        detail: detector?.reason || null,
        evidenceIds: detector?.evidenceIds || [],
      };
    });
  return {
    featureAsOf: row.feature_as_of,
    alert: {
      alertId: row.id,
      canonicalAlertId: row.id,
      sourceAlertId: row.source_alert_id || row.atlassian_ops_alert_id,
      source: episode.source,
      priority: row.priority,
      status: row.status,
      title: row.title,
    },
    sourceIdentity: {
      ...identity,
      source: episode.source,
      entityId: fieldValue('sourceAlertIdentifier', 'applicationId', 'nodeId', 'eventId', 'ruleUid', 'canonicalKey'),
      entity: fieldValue('node', 'host', 'service', 'application') || identity.entity,
      application: fieldValue('application') || identity.application,
      service: fieldValue('service', 'tier') || identity.service,
      environment: fieldValue('environment') || identity.environment,
    },
    temporalFeatures: { createdAt: row.received_at, durationSeconds: current.durationSeconds },
    behaviorFeatures: {
      occurrenceCount: current.occurrences,
      recurrenceCount: current.recurrenceCount,
      persistenceSeconds: current.persistenceSeconds,
      stateTransitionCount: current.stateTransitionCount,
    },
    correlationFeatures: {
      relatedAlertCount: correlation?.relatedAlertCount ?? current.correlatedAlertCount,
      relatedSources: correlation?.relatedSources || [],
      crossSourceActivity: correlation?.crossSourceActivity ?? current.crossSourceActivity,
      sameSignatureRecentCount: historical.previousSameSignature,
    },
    historicalFeatures: {
      previousSameSignatureCount: historical.previousSameSignature,
      previousSameServiceCount: historical.previousSameService,
      previousSameEntityCount: historical.previousSameEntity,
      previousConfirmedIncidentCount: historical.previousIncidentOccurrences,
      previousConfirmedNoiseCount: historical.previousConfirmedNoiseOutcomes,
      historicalIncidentRate: null,
      historicalConfirmedNoiseRate: null,
    },
    observedBehavior,
    alertClassification: {
      domain: snapshot.technicalClassification?.domain,
      subtype: snapshot.technicalClassification?.subtype,
      assignmentMethod: snapshot.technicalClassification?.assignmentMethod,
      assignmentEvidence: [],
    },
    episodeContext: {
      ...(snapshot.episode || episode),
      fingerprintStrength: episode.fingerprintStrength,
      fingerprintComponents: episode.fingerprintComponents,
      canonicalEntity: episode.canonicalEntity,
    },
    jiraIncident: enrichment.relationships.jira.relationship === 'CONFIRMED_RELATIONSHIP'
      ? { incidentKey: enrichment.relationships.jira.incidents[0]?.incidentKey } : null,
    slackFeatures: { slackMessageCount: enrichment.relationships.slack.messages.length },
  };
}

function replayBlocks(row, episode, enrichment) {
  const sourceEvidence = Array.isArray(row.technical_evidence?.sourceSpecificEvidence)
    ? row.technical_evidence.sourceSpecificEvidence : [];
  const provenance = (row.source_provenance || []).find((item) => item.source === episode.source) || row.source_provenance?.[0] || {};
  const normalizeEvidence = (item, index) => ({
    id: item.id || item.evidenceId || `stored-source-evidence:${row.id}:${index}`,
    evidenceId: item.evidenceId || item.id || `stored-source-evidence:${row.id}:${index}`,
    source: item.source || episode.source,
    type: item.type || 'stored_source_evidence',
    title: item.title || null,
    timestamp: item.timestamp || row.feature_as_of,
    metadata: item.metadata || item,
    url: item.url || null,
  });
  const occurrenceSource = canonicalSource(episode.source);
  const occurrenceId = enrichment.fields?.sourceOccurrenceId?.value;
  const occurrenceEvidenceId = occurrenceId
    ? `${normalize(occurrenceSource)}-occurrence:${occurrenceId}` : null;
  const occurrenceEvidence = enrichment.fieldsUsableForIdentity && occurrenceId ? [{
    id: occurrenceEvidenceId,
    evidenceId: occurrenceEvidenceId,
    source: occurrenceSource,
    type: 'source_occurrence_lifecycle',
    title: enrichment.fields.healthRule?.value || enrichment.fields.policy?.value
      || enrichment.fields.ruleName?.value || enrichment.fields.alertRule?.value || null,
    timestamp: enrichment.fields.firingAt?.value || row.feature_as_of,
    metadata: {
      sourceOccurrenceId: occurrenceId,
      eventId: enrichment.fields.eventId?.value || null,
      violationId: enrichment.fields.violationId?.value || null,
      ruleUid: enrichment.fields.ruleUid?.value || null,
      fingerprint: enrichment.fields.fingerprint?.value || null,
      occurrenceState: enrichment.fields.occurrenceState?.value || null,
      currentState: enrichment.fields.currentState?.value || null,
      recoveredAt: enrichment.fields.recoveryAt?.value || null,
      readOnly: true,
    },
    url: enrichment.fields.sourceDeepLink?.value || null,
  }] : [];
  const blocks = [{
    source: episode.source,
    adapter: provenance.adapter || `${episode.source} stored evidence replay`,
    status: occurrenceEvidence.length
      ? 'working' : provenance.status || row.technical_evidence?.provenance?.primaryStatus || 'not_applicable',
    pipelineState: occurrenceEvidence.length || provenance.status !== 'error' ? 'COMPLETE' : 'QUERY_FAILED',
    evidence: [...sourceEvidence.map(normalizeEvidence), ...occurrenceEvidence],
    readOnly: true,
  }];
  const jira = enrichment.relationships.jira;
  blocks.push({
    source: 'ACC Jira', status: 'stored_context', readOnly: true, evidence: [],
    relationships: jira.incidents.map((item) => ({
      relationship: jira.relationship === 'CONFIRMED_RELATIONSHIP' ? 'confirmed' : 'candidate',
      evidenceId: item.evidenceId,
      incidentKey: item.incidentKey,
    })),
  });
  const slackEvidence = enrichment.relationships.slack.messages.map((message) => ({
    id: `slack:${message.channelId}:${message.messageId}`,
    evidenceId: `slack:${message.channelId}:${message.messageId}`,
    source: 'Slack', type: message.acknowledgement ? 'acknowledgement' : 'notification',
    timestamp: row.feature_as_of,
    metadata: {
      actorType: message.responder ? 'HUMAN' : 'SYSTEM',
      activityType: message.acknowledgement ? 'acknowledgement' : 'notification',
      meaningfulAction: false,
      responder: message.responder,
    },
    url: message.permalink,
  }));
  blocks.push({ source: 'Slack', status: 'stored_context', readOnly: true, evidence: slackEvidence });
  return blocks;
}

function qualityCounts(enrichments, selector) {
  return Object.fromEntries(Object.keys(QUALITY).map((quality) => [quality,
    enrichments.filter((item) => selector(item) === quality).length]));
}

function coverage(enrichments, predicate) {
  const review = enrichments.filter((item) => item.currentDecision === 'REVIEW');
  const count = review.filter(predicate).length;
  return { count, total: review.length, percentage: review.length ? Number((count / review.length * 100).toFixed(1)) : 0 };
}

function coverageSubset(enrichments, selector, predicate) {
  const selected = enrichments.filter((item) => item.currentDecision === 'REVIEW' && selector(item));
  const count = selected.filter(predicate).length;
  return { count, total: selected.length, percentage: selected.length ? Number((count / selected.length * 100).toFixed(1)) : 0 };
}

function correlationCounts(report) {
  return {
    strong: report.summary.strongCorrelationCandidates,
    moderate: report.summary.moderateCorrelationCandidates,
    weak: report.summary.weakCorrelationCandidates,
    none: report.summary.noCorrelationPairs,
    crossSource: report.summary.crossSourceCandidatesByLevel,
    sameSourceDifferentRule: report.summary.sameSourceDifferentRuleCandidatesByLevel,
  };
}

function createIdentityRelationshipEnrichmentService({
  database = db,
  episodeService = alertEpisodeService,
  correlationService = episodeCorrelationDiscoveryService,
  clock = () => Date.now(),
} = {}) {
  async function queryRows(sql, params = []) {
    const result = await database.query(sql, params);
    return result.rows;
  }

  async function loadInventory(alertIds, alertNumbers) {
    const identifierPattern = alertNumbers.length
      ? `(^|[^0-9A-Za-z])(${alertNumbers.map((value) => clean(value).replace(/[^0-9A-Za-z_-]/g, ''))
        .filter(Boolean).join('|')})([^0-9A-Za-z]|$)`
      : null;
    const [alerts, grafanaRules, grafanaDashboards, grafanaPanels, grafanaOccurrences, appApplications, appTiers,
      appNodes, appTransactions, appRules, appPolicies, appEvents, appFlow, appOccurrences, nagiosOccurrences, nagiosHosts, nagiosServices,
      mappings, slack, jiraMappings, reconciliations, incidentCandidates] = await Promise.all([
      queryRows(`SELECT alert.id, alert.atlassian_ops_tiny_id, alert.atlassian_ops_alert_id,
          alert.source, alert.source_alert_id, alert.title, alert.description, alert.status,
          alert.raw_payload, alert.extracted_details, alert.source_url, alert.environment,
          alert.service, alert.received_at,
          COALESCE(alert.raw_payload->'priority'->>'name', alert.raw_payload->>'priority',
            alert.raw_payload->>'priorityName', alert.extracted_details->>'priority') AS priority,
          evaluation.source AS evaluation_source, evaluation.feature_as_of,
          evaluation.final_decision, evaluation.feature_snapshot, evaluation.technical_evidence,
          evaluation.source_details, evaluation.source_provenance, evaluation.noise_detection,
          evaluation.explanation
        FROM alerts alert
        LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
        WHERE alert.id = ANY($1::text[])`, [alertIds]),
      queryRows('SELECT * FROM grafana_alert_rules'),
      queryRows('SELECT * FROM grafana_dashboards'),
      queryRows('SELECT * FROM grafana_panels'),
      alertIds.length ? queryRows(`SELECT * FROM grafana_alert_occurrence_evidence
        WHERE alert_id = ANY($1::text[])`, [alertIds]).catch(() => []) : [],
      queryRows('SELECT * FROM appdynamics_applications'),
      queryRows('SELECT * FROM appdynamics_tiers'),
      queryRows('SELECT * FROM appdynamics_nodes'),
      queryRows('SELECT * FROM appdynamics_business_transactions'),
      queryRows('SELECT * FROM appdynamics_health_rules'),
      queryRows("SELECT * FROM appdynamics_policies WHERE to_regclass('appdynamics_policies') IS NOT NULL").catch(() => []),
      queryRows('SELECT * FROM appdynamics_events'),
      queryRows('SELECT * FROM appdynamics_flow_map'),
      alertIds.length ? queryRows(`SELECT * FROM appdynamics_alert_occurrence_evidence
        WHERE alert_id = ANY($1::text[])`, [alertIds]).catch(() => []) : [],
      alertIds.length ? queryRows(`SELECT * FROM nagios_alert_occurrence_evidence
        WHERE alert_id = ANY($1::text[])`, [alertIds]).catch(() => []) : [],
      queryRows('SELECT * FROM nagios_hosts WHERE is_active'),
      queryRows('SELECT * FROM nagios_services WHERE is_active'),
      queryRows(`SELECT mapping.entity_id, mapping.source_system, mapping.source_entity_id,
          mapping.source_entity_name, mapping.source_entity_type, mapping.environment,
          mapping.evidence_level, mapping.confidence_score, mapping.mapping_mechanism,
          mapping.reasons, entity.canonical_name, entity.entity_type AS canonical_entity_type
        FROM source_identity_validated_mappings mapping
        JOIN source_identity_entities entity ON entity.entity_id = mapping.entity_id
        WHERE mapping.validation_status = 'VALID'`),
      alertNumbers.length ? queryRows(`SELECT event.*, raw.parent_message_ts
        FROM slack_alert_events event
        LEFT JOIN slack_raw_messages raw ON raw.slack_channel_id = event.slack_channel_id
          AND raw.message_ts = event.source_message_ts
        WHERE event.alert_number = ANY($1::text[])`, [alertNumbers]) : [],
      queryRows(`SELECT alert_id, jira_ticket_id AS incident_key, mapping_reason, id
        FROM alert_incident_mappings WHERE alert_id = ANY($1::text[]) AND jira_ticket_id IS NOT NULL`, [alertIds]),
      queryRows(`SELECT id, alert_id, incident_key, relationship_state, match_method,
          match_confidence, evidence FROM incident_alert_reconciliations
        WHERE alert_id = ANY($1::text[]) AND current`, [alertIds]),
      identifierPattern ? queryRows(`SELECT incident_key, linked_alerts, comments, custom_fields,
          raw_payload, source_url FROM operations_incidents
        WHERE CONCAT_WS(' ', linked_alerts::text, comments::text, custom_fields::text, raw_payload::text)
          ~ $1`, [identifierPattern]) : [],
    ]);
    return {
      alerts, grafanaRules, grafanaDashboards, grafanaPanels, grafanaOccurrences, appApplications, appTiers,
      appNodes, appTransactions, appRules, appPolicies, appEvents, appFlow, appOccurrences, nagiosOccurrences, nagiosHosts, nagiosServices,
      mappings, slack, jiraMappings, reconciliations, incidentCandidates,
    };
  }

  async function analyze(options = {}) {
    const snapshot = await episodeService.buildSnapshot({ refresh: options.refresh === true });
    const baseline = await correlationService.discover({ refresh: false, limit: 50 });
    const alertIds = unique((snapshot.episodes || []).flatMap((episode) => episode.alertIds || []));
    const alertNumbers = unique((snapshot.episodes || []).flatMap((episode) => (
      (episode.members || []).map((member) => clean(member.tinyId).replace(/^#/, ''))
    )));
    const inventory = await loadInventory(alertIds, alertNumbers);
    const indexes = inventoryIndexes(inventory);
    const alertsById = new Map(inventory.alerts.map((row) => [row.id, row]));
    const slackByNumber = new Map();
    inventory.slack.forEach((row) => {
      const key = clean(row.alert_number).replace(/^#/, '');
      if (!slackByNumber.has(key)) slackByNumber.set(key, []);
      slackByNumber.get(key).push(row);
    });
    const jiraByAlert = new Map();
    const addJira = (alertId, item) => {
      if (!jiraByAlert.has(alertId)) jiraByAlert.set(alertId, []);
      jiraByAlert.get(alertId).push(item);
    };
    inventory.jiraMappings.forEach((row) => addJira(row.alert_id, {
      relationship: 'CONFIRMED_RELATIONSHIP', incidentKey: row.incident_key,
      evidenceId: `alert_incident_mappings:${row.id}`, method: 'explicitAlertIncidentMapping', confidence: 100,
    }));
    inventory.reconciliations.forEach((row) => addJira(row.alert_id, {
      relationship: row.relationship_state === 'CONFIRMED_MATCH' ? 'CONFIRMED_RELATIONSHIP' : 'CANDIDATE_RELATIONSHIP',
      incidentKey: row.incident_key, evidenceId: `incident_alert_reconciliations:${row.id}`,
      method: row.match_method, confidence: row.match_confidence === null ? null : Number(row.match_confidence) * 100,
    }));
    const jiraCandidates = new Map();
    inventory.alerts.forEach((alert) => {
      const candidates = [alert.atlassian_ops_tiny_id, alert.atlassian_ops_alert_id, alert.source_alert_id].filter(Boolean);
      inventory.incidentCandidates.forEach((incident) => {
        const token = exactToken({
          linkedAlerts: incident.linked_alerts,
          comments: incident.comments,
          customFields: incident.custom_fields,
          rawPayload: incident.raw_payload,
        }, candidates);
        if (!token) return;
        if (!jiraCandidates.has(alert.id)) jiraCandidates.set(alert.id, []);
        jiraCandidates.get(alert.id).push({
          relationship: 'CANDIDATE_RELATIONSHIP', incidentKey: incident.incident_key,
          evidenceId: `operations_incidents:${incident.incident_key}`, method: 'exactIdentifierInStoredJiraEvidence',
          matchedIdentifier: token, confidence: 85,
        });
      });
    });

    const registry = new Map();
    const enrichments = (snapshot.episodes || []).map((episode) => {
      const rows = episode.alertIds.map((id) => alertsById.get(id)).filter(Boolean);
      const episodeNumbers = unique((episode.members || []).map((member) => clean(member.tinyId).replace(/^#/, '')));
      const slackRows = episodeNumbers.flatMap((number) => slackByNumber.get(number) || []);
      const extractions = [
        ...rows.map((row) => extractRawOperationsIdentity({
        ...safeJson(row.raw_payload, {}),
        extractedDetails: safeJson(row.extracted_details, {}),
        sourceUrl: row.source_url,
        title: row.title,
        description: row.description,
        }, { alertId: row.id, source: episode.source })),
        ...slackRows.map((row) => extractRawOperationsIdentity({
          ...safeJson(row.raw_payload, {}),
          title: row.title,
          message: row.raw_message,
          links: row.links,
          permalink: row.slack_permalink,
          application: row.application,
          service: row.service,
          environment: row.environment,
          tier: row.tier,
        }, { alertId: row.alert_id || row.alert_number, source: episode.source })),
      ];
      let fields = {};
      if (episode.source === 'Grafana') fields = resolveGrafana(episode, extractions, indexes);
      else if (episode.source === 'AppDynamics') fields = resolveAppDynamics(episode, extractions, indexes, inventory);
      else if (episode.source === 'Nagios') fields = resolveNagios(episode, extractions, indexes);
      else {
        const application = extractedValues(extractions, 'applicationNames');
        const service = extractedValues(extractions, 'serviceNames');
        fields = {
          application: application.length === 1 ? resolved(application[0], 'JSM Operations / stored alert payload', 'structuredApplicationName', 90, 'STRUCTURED') : null,
          service: service.length === 1 ? resolved(service[0], 'JSM Operations / stored alert payload', 'structuredServiceName', 90, 'STRUCTURED') : null,
        };
      }
      const relationships = relationshipSummary(episode, alertsById, slackByNumber, jiraByAlert, jiraCandidates);
      const conflicts = extractions.flatMap((item) => item.conflicts || []);
      const fallbackField = episode.fingerprintStrength === 'SIGNATURE_FALLBACK'
        ? resolved(episode.canonicalEntity || episode.ruleEvent || episode.fingerprintHash,
          'Existing episode fingerprint', 'signatureFallback', 40, 'SIGNATURE_FALLBACK') : null;
      if (!Object.values(fields).some(Boolean) && fallbackField) fields.fallbackIdentity = fallbackField;
      const beforeIdentityQuality = baseQuality(episode);
      const proposedIdentityQuality = qualityFromFields(fields, conflicts);
      const fieldsUsableForIdentity = ['AUTHORITATIVE', 'STRUCTURED'].includes(proposedIdentityQuality);
      const item = {
        episodeId: episode.episodeId,
        alertIds: episode.alertIds,
        source: episode.source,
        currentDecision: decisionName(episode.episodeDecision),
        beforeIdentityQuality,
        proposedIdentityQuality,
        identityQuality: QUALITY[proposedIdentityQuality] > QUALITY[beforeIdentityQuality]
          ? proposedIdentityQuality : beforeIdentityQuality,
        fieldsUsableForIdentity,
        fields,
        relationships,
        conflicts,
        rawExtraction: {
          valuesExtracted: extractions.reduce((sum, extraction) => sum + Number(extraction.valueCount || 0), 0),
          provenanceTypes: unique(extractions.flatMap((extraction) => extraction.provenance || []).map((entry) => entry.provenanceType)),
          redacted: true,
        },
      };
      const sourceEntity = strongestField([fields.ruleUid, fields.applicationId, fields.application,
        fields.canonicalKey, fields.host, fields.service]);
      const canonical = strongestField([fields.application, fields.service, fields.host]);
      if (fieldsUsableForIdentity) addRegistryEntry(registry, episode, sourceEntity, canonical, {
        episodeId: episode.episodeId,
        sourceField: sourceEntity?.resolutionMethod,
        canonicalField: canonical?.resolutionMethod,
      });
      return item;
    });
    const byEpisode = new Map(enrichments.map((item) => [item.episodeId, item]));
    const enrichedEpisodes = snapshot.episodes.map((episode) => enhanceEpisode(episode, byEpisode.get(episode.episodeId)));
    const storedMappingKeys = new Set(inventory.mappings.flatMap((row) => (
      [row.source_entity_id, row.source_entity_name].filter(Boolean)
        .map((value) => `${normalize(row.source_system)}|${normalize(value)}`)
    )));
    const derivedGroups = new Map();
    [...registry.values()].forEach((row) => {
      const key = `${normalize(row.source_system)}|${normalize(row.source_entity_id)}`;
      if (!derivedGroups.has(key)) derivedGroups.set(key, []);
      derivedGroups.get(key).push(row);
    });
    const derivedMappingRows = [...derivedGroups.entries()].flatMap(([key, rows]) => {
      if (storedMappingKeys.has(key)) return [];
      const canonicalIds = unique(rows.map((row) => row.entity_id));
      // A derived alias with more than one canonical target is ambiguous and
      // is withheld from correlation discovery rather than guessed.
      return canonicalIds.length === 1 ? [rows[0]] : [];
    });
    const enrichedSnapshot = { ...snapshot, episodes: enrichedEpisodes };
    const enrichedCorrelationService = createEpisodeCorrelationDiscoveryService({
      database,
      episodeService: { async buildSnapshot() { return enrichedSnapshot; } },
      clock,
      contextEnhancer: async (context) => ({
        ...context,
        mappingRows: [...context.mappingRows, ...derivedMappingRows],
        mappingIndex: require('./episodeCorrelationDiscovery.service').buildMappingIndex([
          ...context.mappingRows, ...derivedMappingRows,
        ]),
      }),
    });
    const enrichedCorrelation = await enrichedCorrelationService.discover({ limit: 50 });
    const beforeByPair = new Map((baseline.topCandidates || []).map((item) => [item.pairId, item]));
    const rank = { NO_CORRELATION: 0, WEAK_CORRELATION: 1, MODERATE_CORRELATION: 2, STRONG_CORRELATION: 3 };
    const correlationImprovements = (enrichedCorrelation.topCandidates || []).filter((item) => (
      rank[item.level] > rank[beforeByPair.get(item.pairId)?.level || 'NO_CORRELATION']
    )).map((item) => ({
      pairId: item.pairId,
      episodes: [item.episodeA, item.episodeB],
      before: beforeByPair.get(item.pairId)?.level || 'NO_CORRELATION',
      after: item.level,
      newlyResolvedEvidence: item.evidence.filter((evidence) => (
        ['identity', 'slack', 'jira', 'topology'].includes(evidence.category)
      )),
    }));
    const observationChanges = [];
    const hypothetical = [];
    for (const episode of enrichedEpisodes) {
      const enrichment = byEpisode.get(episode.episodeId);
      const row = episode.alertIds.map((id) => alertsById.get(id)).find((item) => item?.feature_snapshot);
      if (!row) {
        hypothetical.push({ episodeId: episode.episodeId, current: enrichment.currentDecision, hypothetical: enrichment.currentDecision, replayStatus: 'STORED_EVALUATION_INPUT_UNAVAILABLE' });
        continue;
      }
      const originalEpisode = (snapshot.episodes || []).find((item) => item.episodeId === episode.episodeId) || episode;
      const noRelationships = {
        ...enrichment,
        fields: {},
        relationships: {
          slack: { relationship: 'NO_RELATIONSHIP_FOUND', messages: [] },
          jira: { relationship: 'NO_RELATIONSHIP_FOUND', incidents: [] },
        },
      };
      const baselineRecord = replayRecord(row, originalEpisode, noRelationships, null);
      const baselineBlocks = replayBlocks(row, originalEpisode, noRelationships);
      const baselineReplay = evaluateUnifiedEvidence({
        record: baselineRecord, blocks: baselineBlocks, technicalEvidence: row.technical_evidence || {},
        source: originalEpisode.source, featureAsOf: row.feature_as_of,
      });
      // Candidate correlations are discovery output, not confirmed operational
      // relationships. They are deliberately excluded from the decision replay.
      const record = replayRecord(row, episode, enrichment, null);
      const blocks = replayBlocks(row, episode, enrichment);
      const replay = evaluateUnifiedEvidence({
        record, blocks, technicalEvidence: observationTechnicalEvidence(row, episode, enrichment), source: episode.source,
        featureAsOf: row.feature_as_of,
      });
      const baselineDecision = decisionName(baselineReplay.finalDecision);
      const replayComparable = baselineDecision === enrichment.currentDecision;
      const next = replayComparable ? decisionName(replay.finalDecision) : enrichment.currentDecision;
      const result = {
        episodeId: episode.episodeId,
        current: enrichment.currentDecision,
        hypothetical: next,
        replayStatus: replayComparable ? 'OBSERVATION_ONLY'
          : 'STORED_INPUT_REPLAY_DIVERGED_CURRENT_DECISION_RETAINED',
        baselineReplay: baselineDecision,
        newlyResolvedEvidence: Object.entries(enrichment.fieldsUsableForIdentity ? enrichment.fields : {}).filter(([, value]) => value)
          .map(([field, value]) => ({ field, value: value.value, method: value.resolutionMethod, authority: value.authority })),
        decisionPath: {
          policy: replay.decisionPolicy,
          basis: replay.explanation?.decisionBasis,
          reasons: replay.explanation?.reasons || [],
          blockers: replay.explanation?.decisionBlockers || [],
        },
      };
      hypothetical.push(result);
      if (replayComparable && result.current !== result.hypothetical) observationChanges.push(result);
    }
    const currentCounts = Object.fromEntries(['INCIDENT', 'NOISE', 'REVIEW'].map((decision) => [decision,
      enrichments.filter((item) => item.currentDecision === decision).length]));
    const hypotheticalCounts = Object.fromEntries(['INCIDENT', 'NOISE', 'REVIEW'].map((decision) => [decision,
      hypothetical.filter((item) => item.hypothetical === decision).length]));
    const review = enrichments.filter((item) => item.currentDecision === 'REVIEW');
    const beforeQuality = qualityCounts(review, (item) => item.beforeIdentityQuality);
    const afterQuality = qualityCounts(review, (item) => item.identityQuality);
    return {
      generatedAt: new Date(clock()).toISOString(),
      policy: POLICY,
      mode: 'READ_ONLY_SHADOW_OBSERVATION',
      inventory: {
        grafana: { rules: inventory.grafanaRules.length, dashboards: inventory.grafanaDashboards.length, panels: inventory.grafanaPanels.length },
        appDynamics: {
          applications: inventory.appApplications.length,
          tiers: inventory.appTiers.length,
          nodes: inventory.appNodes.length,
          transactions: inventory.appTransactions.length,
          healthRules: inventory.appRules.length,
          policies: (inventory.appPolicies || []).length,
          events: inventory.appEvents.length,
          occurrences: (inventory.appOccurrences || []).length,
          topology: inventory.appFlow.length,
        },
        nagios: { hosts: inventory.nagiosHosts.length, services: inventory.nagiosServices.length,
          occurrences: (inventory.nagiosOccurrences || []).length },
        slackRelationships: inventory.slack.length,
        validatedMappings: inventory.mappings.length,
      },
      identityDiagnostics: {
        reviewEpisodes: review.length,
        before: beforeQuality,
        after: afterQuality,
        signatureFallbackUpgraded: review.filter((item) => item.beforeIdentityQuality === 'SIGNATURE_FALLBACK'
          && ['AUTHORITATIVE', 'STRUCTURED'].includes(item.identityQuality)).length,
        unresolvedUpgraded: review.filter((item) => item.beforeIdentityQuality === 'UNRESOLVED'
          && ['AUTHORITATIVE', 'STRUCTURED'].includes(item.identityQuality)).length,
        coverage: {
          grafanaRuleUid: coverageSubset(enrichments, (item) => item.source === 'Grafana', (item) => Boolean(item.fields.ruleUid)),
          grafanaLabels: coverageSubset(enrichments, (item) => item.source === 'Grafana', (item) => Boolean(item.fields.labels)),
          applicationMapping: coverage(enrichments, (item) => Boolean(item.fields.application)),
          nagiosHost: coverageSubset(enrichments, (item) => item.source === 'Nagios', (item) => Boolean(item.fields.host)),
          appDynamicsTopology: coverageSubset(enrichments, (item) => item.source === 'AppDynamics',
            (item) => Boolean(item.fields.tier || item.fields.node || item.fields.businessTransaction || item.fields.backendDependency)),
          slackRelationship: coverage(enrichments, (item) => item.relationships.slack.relationship === 'STRUCTURED_RELATIONSHIP'),
          jiraRelationship: coverage(enrichments, (item) => item.relationships.jira.relationship !== 'NO_RELATIONSHIP_FOUND'),
        },
      },
      relationshipDiagnostics: {
        slack: Object.fromEntries(['STRUCTURED_RELATIONSHIP', 'NO_RELATIONSHIP_FOUND'].map((value) => [value,
          review.filter((item) => item.relationships.slack.relationship === value).length])),
        jiraJsm: Object.fromEntries(['CONFIRMED_RELATIONSHIP', 'CANDIDATE_RELATIONSHIP', 'NO_RELATIONSHIP_FOUND'].map((value) => [value,
          review.filter((item) => item.relationships.jira.relationship === value).length])),
      },
      derivedMappingRegistry: {
        entries: derivedMappingRows,
        count: derivedMappingRows.length,
        persisted: false,
      },
      correlationDiscovery: {
        before: correlationCounts(baseline),
        after: correlationCounts(enrichedCorrelation),
        improvements: correlationImprovements,
      },
      observationMode: {
        current: currentCounts,
        enrichedHypothetical: hypotheticalCounts,
        changes: observationChanges,
        evaluations: hypothetical,
        comparableEpisodes: hypothetical.filter((item) => item.replayStatus === 'OBSERVATION_ONLY').length,
        storedInputReplayDivergences: hypothetical.filter((item) => item.replayStatus === 'STORED_INPUT_REPLAY_DIVERGED_CURRENT_DECISION_RETAINED').length,
        missingStoredInputs: hypothetical.filter((item) => item.replayStatus === 'STORED_EVALUATION_INPUT_UNAVAILABLE').length,
        correlationCandidatesUsedAsDecisions: 0,
        classificationsPersisted: 0,
      },
      episodes: enrichments.slice(0, Math.min(100, Math.max(1, Number(options.limit) || 100))),
      safeguards: {
        classificationRulesFrozen: true,
        episodeGroupingChanged: false,
        correlatedNoiseImplemented: false,
        classificationsChanged: 0,
        classificationWrites: 0,
        humanOutcomeWrites: 0,
        historicalLabelChanges: 0,
        jiraWrites: 0,
        slackWrites: 0,
        monitoringWrites: 0,
        externalMutations: 0,
        automaticActionsEnabled: false,
        machineLearningTrainingPerformed: false,
        titleOnlyAuthoritativeMappings: 0,
        temporalOnlyConfirmedCorrelations: 0,
        signatureFallbackStrongAuthority: 0,
      },
    };
  }

  return { analyze, loadInventory };
}

module.exports = {
  POLICY,
  QUALITY,
  canonicalSource,
  createIdentityRelationshipEnrichmentService,
  enhanceEpisode,
  exactToken,
  inventoryIndexes,
  qualityFromFields,
  relationshipSummary,
  observationTechnicalEvidence,
  resolved,
  resolveAppDynamics,
  resolveGrafana,
  resolveNagios,
  service: createIdentityRelationshipEnrichmentService(),
};
