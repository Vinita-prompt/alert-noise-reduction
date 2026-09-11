const crypto = require('node:crypto');
const appDynamicsService = require('./appDynamics.service');
const grafanaService = require('./grafanaDashboard.service');
const nagiosService = require('./nagios.service');
const { workspaceService: thousandEyesService } = require('./thousandEyesWorkspace.service');

const ACCEPTED_STATES = new Set(['EXACT', 'STRONG']);
const SUPPORTED_SOURCES = new Set(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);
const GENERIC_VALUES = new Set([
  'api', 'cpu', 'memory', 'production', 'prod', 'plt', 'kubernetes', 'service', 'application',
  'alert', 'monitoring', 'unknown', 'critical', 'warning', 'high', 'low',
]);
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const MAX_CATALOG_PAGES = 100;

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9.:/-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function unique(values) {
  return [...new Set((values || []).flat().filter((value) => value !== null && value !== undefined)
    .map(cleanText).filter(Boolean))];
}

function safeCode(error, fallback) {
  return cleanText(error?.code || error?.safeMessage || error?.status || fallback).slice(0, 160);
}

function stableHash(value, length = 24) {
  const stable = (item) => {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === 'object') return Object.keys(item).sort().reduce((output, key) => {
      output[key] = stable(item[key]); return output;
    }, {});
    return item;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, length);
}

function canonicalSource(value) {
  const source = normalize(value);
  if (/appd|app-dynamics/.test(source)) return 'AppDynamics';
  if (source.includes('grafana')) return 'Grafana';
  if (source.includes('nagios')) return 'Nagios';
  if (source.includes('thousandeyes') || source.includes('thousand-eyes')) return 'ThousandEyes';
  return cleanText(value) || 'Unknown';
}

function isGeneric(value) {
  const item = normalize(value);
  return !item || GENERIC_VALUES.has(item) || item.length < 3;
}

function environment(value) {
  const item = normalize(value);
  if (!item) return null;
  if (/(^|[-.:/])(dc0?1|d0?1)([-.:/]|$)/.test(item)) return 'dc01';
  if (/(^|[-.:/])(dc0?2|d0?2)([-.:/]|$)/.test(item)) return 'dc02';
  if (/(^|[-.:/])(prod|production)([-.:/]|$)/.test(item)) return 'production';
  if (/(^|[-.:/])(qa|quality)([-.:/]|$)/.test(item)) return 'qa';
  if (/(^|[-.:/])(stage|staging|stg)([-.:/]|$)/.test(item)) return 'staging';
  if (/(^|[-.:/])(dev|development)([-.:/]|$)/.test(item)) return 'development';
  return item;
}

function titleClue(value, source) {
  let title = cleanText(value).replace(/^\[[^\]]+\]\s*:?[\s-]*/i, '');
  if (source === 'Grafana') title = title.split(/\s+-\s+/)[0];
  if (source === 'AppDynamics') title = title.split(/\s+AppD\s*-|\s+-\s+/i)[0];
  if (source === 'Nagios') title = title.replace(/^Nagios\s*[-:]\s*/i, '');
  return cleanText(title);
}

function objectValues(value, keys, depth = 0, output = []) {
  if (!value || depth > 5 || output.length > 80) return output;
  if (Array.isArray(value)) {
    value.forEach((item) => objectValues(item, keys, depth + 1, output));
    return output;
  }
  if (typeof value !== 'object') return output;
  Object.entries(value).forEach(([key, item]) => {
    if (keys.has(normalize(key)) && ['string', 'number'].includes(typeof item) && cleanText(item)) {
      output.push({ field: key, value: cleanText(item) });
    }
    if (item && typeof item === 'object') objectValues(item, keys, depth + 1, output);
  });
  return output;
}

function knownClues(input = {}) {
  const source = canonicalSource(input.source || input.knownIdentity?.sources?.[0]);
  const known = input.knownIdentity || {};
  const alerts = Array.isArray(input.normalizedAlerts)
    ? input.normalizedAlerts
    : input.normalizedAlert ? [input.normalizedAlert] : [];
  const raw = known.rawExtraction?.extracted || input.rawIdentityEvidence?.extracted || {};
  const structured = alerts.flatMap((alert) => [alert, alert?.sourceDetails, alert?.extraProperties, alert?.labels, alert?.annotations]).filter(Boolean);
  const labelKeys = new Set(['alertname', 'instance', 'job', 'namespace', 'pod', 'deployment', 'folder',
    'folderuid', 'team', 'service', 'environment', 'env', 'application', 'target', 'testname']);
  const labels = structured.flatMap((item) => objectValues(item, labelKeys));
  const values = (fieldNames) => unique(labels.filter((item) => fieldNames.includes(normalize(item.field))).map((item) => item.value));
  const titles = unique(alerts.map((alert) => titleClue(alert?.title || alert?.message || alert?.summary, source)));
  const applications = unique([...(known.applications || []), ...(raw.applicationNames || []), ...values(['application'])]);
  const services = unique([...(known.services || []), ...(raw.serviceNames || []), ...values(['service'])]);
  const environments = unique([known.environment, ...(known.environments || []), ...(raw.environmentNames || []), ...values(['environment', 'env'])]);
  const rules = unique([...(known.rules || []), ...(raw.ruleNames || []), ...values(['alertname']), ...titles]);
  const hosts = unique([...(known.hosts || []), ...(raw.hostNames || [])]);
  const businessTransactions = unique([...(known.businessTransactions || []), ...(raw.businessTransactionNames || [])]);
  return {
    source,
    applicationIds: unique([...(known.appDynamicsApplicationIds || []), ...(raw.applicationIds || [])]),
    applications,
    services,
    environments,
    environment: environment(environments[0]),
    rules,
    ruleUids: unique([...(known.grafanaRuleUids || []), ...(raw.ruleUids || [])]),
    dashboardUids: unique([...(known.grafanaDashboardUids || []), ...(raw.dashboardUids || [])]),
    panelIds: unique([...(known.grafanaPanelIds || []), ...(raw.panelIds || [])]),
    folders: unique(values(['folder', 'folderuid'])),
    instances: unique([...(raw.instances || []), ...values(['instance'])]),
    jobs: unique(values(['job'])), namespaces: unique(values(['namespace'])), pods: unique(values(['pod'])),
    deployments: unique(values(['deployment'])), teams: unique(values(['team'])),
    hosts,
    serviceIds: unique(raw.serviceIds || []), hostIds: unique(raw.hostIds || []),
    businessTransactions,
    nodeIds: unique(raw.nodeIds || []), tierIds: unique(raw.tierIds || []),
    testIds: unique([...(known.testIds || []), ...(raw.testIds || [])]),
    testNames: unique([...(raw.sourceEntityNames || []), ...values(['testname']), ...titles]),
    targets: unique([...(raw.targets || []), ...values(['target'])]),
    agents: unique([...(known.agentIds || []), ...(raw.agents || [])]),
    titles,
  };
}

function catalogItemId(item) {
  return cleanText(item?.id || item?.uid || item?.testId || item?.sourceEntityId);
}

function normalizeGrafanaRule(item = {}) {
  const kind = item.kind || (item.sourceEntityType ? normalize(item.sourceEntityType) : 'alert_rule');
  if (!['alert_rule', 'alertrule'].includes(kind)) {
    return {
      ...item,
      id: cleanText(item.id || item.uid || item.sourceEntityId),
      uid: cleanText(item.uid || item.id || item.sourceEntityId),
      name: cleanText(item.name || item.title),
      kind,
      sourceEntityType: item.sourceEntityType || String(kind).toUpperCase(),
    };
  }
  return {
    id: cleanText(item.uid || item.id), uid: cleanText(item.uid || item.id), name: cleanText(item.title || item.name),
    kind: 'alert_rule', sourceEntityType: 'ALERT_RULE', folder: cleanText(item.folderTitle || item.folder || item.folder_name),
    folderUid: cleanText(item.folderUid), ruleGroup: cleanText(item.ruleGroup), labels: item.labels || {},
    annotations: item.annotations || {}, dashboardUid: cleanText(item.dashboard?.uid || item.dashboardUid),
    panelId: cleanText(item.dashboard?.panelId || item.panelId), datasources: item.datasources || [],
    condition: item.condition || null, duration: item.duration || null, lastValidatedAt: item.updatedAt || item.lastValidatedAt || null,
  };
}

function normalizeAppDynamicsItem(item = {}) {
  return {
    ...item, id: catalogItemId(item), name: cleanText(item.name), kind: item.kind || 'application',
    sourceEntityType: item.sourceEntityType || 'APPLICATION', environment: item.environment || environment(item.name),
  };
}

function normalizeNagiosItem(item = {}, instance = null, type = null) {
  const host = cleanText(item.host || item.hostName || item.name);
  const service = cleanText(item.service || item.serviceDescription);
  const site = environment(instance || item.instance || item.environment);
  return {
    id: catalogItemId(item) || `${site || 'unknown'}:${host}${service ? `:${service}` : ''}`,
    name: service ? `${host} · ${service}` : host, host, service, instance: site,
    environment: site, kind: type || item.kind || (service ? 'service' : 'host'),
    sourceEntityType: service ? 'SERVICE' : 'HOST', status: item.status || null,
    lastValidatedAt: item.sourceUpdatedAt || item.lastValidatedAt || null,
  };
}

function normalizeThousandEyesItem(item = {}) {
  return {
    ...item, id: cleanText(item.id || item.testId), testId: cleanText(item.testId || item.id),
    name: cleanText(item.name), kind: 'test', sourceEntityType: 'TEST', target: cleanText(item.target),
    agents: unique(item.agents || item.agentIds || []),
  };
}

function mergeCatalog(primary = [], fallback = [], normalizer = (item) => item) {
  const byId = new Map();
  [...primary, ...fallback].map(normalizer).filter((item) => catalogItemId(item)).forEach((item) => {
    const key = `${normalize(item.sourceEntityType || item.kind)}:${normalize(catalogItemId(item))}`;
    if (!byId.has(key)) byId.set(key, item);
  });
  return [...byId.values()];
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1; results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function loadGrafanaCatalog(refresh = false) {
  const items = []; let page = 1; let hasNext = true;
  while (hasNext && page <= MAX_CATALOG_PAGES) {
    const response = await grafanaService.listGrafanaWorkspaceAlertRules({ page, pageSize: 50, refresh: refresh && page === 1 });
    items.push(...(response.items || [])); hasNext = response.pagination?.hasNext === true; page += 1;
  }
  return { items: items.map(normalizeGrafanaRule), pages: page - 1 };
}

async function loadAppDynamicsCatalog(refresh = false) {
  const response = await appDynamicsService.getApplicationIdentityInventory({ refresh });
  return { items: (response.applications || []).map(normalizeAppDynamicsItem), pages: 1 };
}

async function loadNagiosCatalog(refresh = false) {
  const snapshots = await Promise.all(['d01', 'd02'].map((key) => nagiosService.getWorkspaceSnapshot(key, { forceRefresh: refresh })));
  return {
    items: snapshots.flatMap((snapshot) => [
      ...(snapshot.hosts || []).map((item) => normalizeNagiosItem(item, snapshot.instance?.environment || snapshot.instance?.key, 'host')),
      ...(snapshot.services || []).map((item) => normalizeNagiosItem(item, snapshot.instance?.environment || snapshot.instance?.key, 'service')),
    ]), pages: snapshots.length,
  };
}

async function loadThousandEyesCatalog(refresh = false) {
  const response = await thousandEyesService.getIdentityInventory({ refresh });
  return { items: (response.tests || []).map(normalizeThousandEyesItem), pages: 1 };
}

function resultBase(source, state, details = {}) {
  return {
    source, discoveryState: state, entityType: details.entityType || null,
    entityId: details.entityId || null, entityName: details.entityName || null,
    sourceSpecificIdentity: details.sourceSpecificIdentity || {}, candidates: details.candidates || [],
    matchingAttributes: details.matchingAttributes || [], conflictingAttributes: details.conflictingAttributes || [],
    evidenceUsed: details.evidenceUsed || [], evidenceMissing: details.evidenceMissing || [],
    reasoning: details.reasoning || null, blocker: details.blocker || null,
    inventoryVersion: details.inventoryVersion || null, patternKey: details.patternKey || null,
    cacheHit: details.cacheHit === true, accepted: ACCEPTED_STATES.has(state),
    readOnly: true, externalMutations: 'none', classificationDecision: null,
  };
}

function attribute(field, operationsValue, inventoryValue) {
  return { field, operationsValue: cleanText(operationsValue), inventoryValue: cleanText(inventoryValue) };
}

function valuesMatch(left, right) {
  return Boolean(normalize(left) && normalize(left) === normalize(right));
}

function itemFieldValues(item, field) {
  if (field === 'environment') return unique([item.environment, item.labels?.environment, item.labels?.env, item.annotations?.environment]);
  if (field === 'service') return unique([item.labels?.service, item.labels?.application, item.annotations?.service, item.annotations?.application]);
  if (field === 'instance') return unique([item.labels?.instance, item.annotations?.instance]);
  if (field === 'job') return unique([item.labels?.job]);
  if (field === 'namespace') return unique([item.labels?.namespace]);
  if (field === 'pod') return unique([item.labels?.pod]);
  if (field === 'deployment') return unique([item.labels?.deployment]);
  if (field === 'team') return unique([item.labels?.team, item.annotations?.team]);
  if (field === 'folder') return unique([item.folder, item.folderUid]);
  return [];
}

function matchingConstraints(item, clues) {
  const definitions = [
    ['environment', clues.environments], ['service', clues.services], ['instance', clues.instances],
    ['job', clues.jobs], ['namespace', clues.namespaces], ['pod', clues.pods],
    ['deployment', clues.deployments], ['team', clues.teams], ['folder', clues.folders],
  ];
  const matching = []; const conflicting = [];
  definitions.forEach(([field, operationValues]) => {
    const inventoryValues = itemFieldValues(item, field);
    if (!operationValues.length || !inventoryValues.length) return;
    const operationValue = operationValues.find((value) => inventoryValues.some((candidate) => valuesMatch(value, candidate)));
    if (operationValue) {
      const inventoryValue = inventoryValues.find((candidate) => valuesMatch(operationValue, candidate));
      matching.push(attribute(field, operationValue, inventoryValue));
    } else conflicting.push({ field, operationsValues: operationValues, inventoryValues });
  });
  return { matching, conflicting };
}

function discoverGrafana(clues, items, context = {}) {
  const rules = items.filter((item) => item.kind === 'alert_rule' && item.id);
  const exactUid = rules.filter((item) => clues.ruleUids.some((value) => valuesMatch(value, item.id)));
  if (exactUid.length === 1) {
    const item = exactUid[0];
    return resultBase('Grafana', 'EXACT', {
      entityType: 'ALERT_RULE', entityId: item.id, entityName: item.name,
      sourceSpecificIdentity: { ruleUid: item.id, ruleName: item.name, folder: item.folder, folderUid: item.folderUid,
        dashboardUid: item.dashboardUid, panelId: item.panelId, labels: item.labels, annotations: item.annotations,
        datasources: item.datasources, condition: item.condition, duration: item.duration },
      matchingAttributes: [attribute('ruleUid', clues.ruleUids[0], item.id)],
      evidenceUsed: [`Exact Grafana rule UID ${item.id} exists in the current rule catalog.`],
      reasoning: 'The explicit source rule UID selects exactly one current Grafana alert rule.', ...context,
    });
  }
  if (exactUid.length > 1) return resultBase('Grafana', 'CONFLICT', {
    candidates: exactUid.map((item) => ({ id: item.id, name: item.name, folder: item.folder })),
    conflictingAttributes: [{ field: 'ruleUid', values: clues.ruleUids }],
    evidenceMissing: ['A unique current Grafana rule UID'], blocker: 'NO_UNIQUE_GRAFANA_RULE',
    reasoning: 'The supplied Grafana rule identifier maps to multiple catalog records.', ...context,
  });

  const names = unique(clues.rules).filter((value) => !isGeneric(value));
  const named = rules.filter((item) => names.some((value) => valuesMatch(value, item.name)));
  const evaluated = named.map((item) => ({ item, ...matchingConstraints(item, clues) }));
  const compatible = evaluated.filter((entry) => entry.conflicting.length === 0);
  const ranked = compatible.sort((left, right) => right.matching.length - left.matching.length);
  const best = ranked[0];
  if (best && ranked.filter((entry) => entry.matching.length === best.matching.length).length === 1 && best.matching.length >= 1) {
    const item = best.item;
    const name = names.find((value) => valuesMatch(value, item.name));
    return resultBase('Grafana', 'STRONG', {
      entityType: 'ALERT_RULE', entityId: item.id, entityName: item.name,
      sourceSpecificIdentity: { ruleUid: item.id, ruleName: item.name, folder: item.folder, folderUid: item.folderUid,
        dashboardUid: item.dashboardUid, panelId: item.panelId, labels: item.labels, annotations: item.annotations,
        datasources: item.datasources, condition: item.condition, duration: item.duration },
      matchingAttributes: [attribute('alertname', name, item.name), ...best.matching],
      candidates: named.filter((candidate) => candidate.id !== item.id).map((candidate) => ({ id: candidate.id, name: candidate.name, folder: candidate.folder, rejected: true })),
      evidenceUsed: [`Exact Grafana alert name ${item.name}.`, ...best.matching.map((match) => `Matching ${match.field}: ${match.inventoryValue}.`),
        'All other same-name rules were rejected by deterministic catalog constraints.'],
      reasoning: 'The Operations alert name plus source-side attributes select exactly one compatible Grafana rule.', ...context,
    });
  }
  if (named.length > 1 || (ranked.length > 1 && ranked[0]?.matching.length === ranked[1]?.matching.length)) {
    return resultBase('Grafana', 'CONFLICT', {
      candidates: (ranked.length ? ranked : evaluated).map(({ item, matching, conflicting }) => ({
        id: item.id, name: item.name, folder: item.folder, matchingAttributes: matching, conflictingAttributes: conflicting,
      })),
      evidenceMissing: ['A folder, environment, instance, or structured label that selects one Grafana rule'],
      blocker: 'NO_UNIQUE_GRAFANA_RULE',
      reasoning: 'More than one Grafana rule remains compatible with the available deterministic Operations clues.', ...context,
    });
  }
  if (named.length === 1) {
    return resultBase('Grafana', 'UNKNOWN', {
      candidates: [{ id: named[0].id, name: named[0].name, folder: named[0].folder }],
      matchingAttributes: [attribute('alertname', names.find((value) => valuesMatch(value, named[0].name)), named[0].name)],
      evidenceMissing: ['One additional deterministic Grafana attribute such as folder, environment, instance, or label'],
      blocker: 'NO_UNIQUE_GRAFANA_RULE',
      reasoning: 'An alert-name candidate exists, but rule name alone is not sufficient for automatic promotion.', ...context,
    });
  }
  return resultBase('Grafana', 'UNKNOWN', {
    evidenceMissing: ['A Grafana rule UID or exact rule name with a deterministic source-side discriminator'],
    blocker: 'NO_GRAFANA_RULE_MATCH',
    reasoning: 'No current Grafana rule matches the available non-generic Operations identity clues.', ...context,
  });
}

function itemNameCandidates(item) {
  return unique([item.name, item.host, item.service]);
}

function stripEnvironmentPrefix(value) {
  return normalize(value).replace(/^(?:prod|production|qa|quality|stage|staging|stg|dev|development|test|testing)-/, '');
}

function discoverAppDynamics(clues, items, context = {}) {
  const inventory = items.filter((item) => item.id && item.name);
  const exactId = inventory.filter((item) => clues.applicationIds.some((value) => valuesMatch(value, item.id)));
  if (exactId.length === 1) return resultBase('AppDynamics', 'EXACT', {
    entityType: exactId[0].sourceEntityType, entityId: exactId[0].id, entityName: exactId[0].name,
    sourceSpecificIdentity: { applicationId: exactId[0].applicationId || exactId[0].id, tierName: exactId[0].tierName,
      node: exactId[0].host, entityKind: exactId[0].kind },
    matchingAttributes: [attribute('applicationId', clues.applicationIds[0], exactId[0].id)],
    evidenceUsed: [`Exact AppDynamics identifier ${exactId[0].id} exists in current inventory.`],
    reasoning: 'The explicit AppDynamics identifier selects exactly one current source entity.', ...context,
  });
  const preferredNames = clues.businessTransactions.length ? clues.businessTransactions
    : unique([...clues.applications, ...clues.services, ...clues.titles, ...clues.hosts]).filter((value) => !isGeneric(value));
  const candidates = inventory.filter((item) => preferredNames.some((value) => valuesMatch(value, item.name)
    || (item.kind === 'application' && stripEnvironmentPrefix(value) === stripEnvironmentPrefix(item.name))));
  const compatible = candidates.filter((item) => !clues.environment || !item.environment || environment(item.environment) === clues.environment);
  if (compatible.length === 1) {
    const item = compatible[0]; const value = preferredNames.find((name) => valuesMatch(name, item.name)
      || stripEnvironmentPrefix(name) === stripEnvironmentPrefix(item.name));
    return resultBase('AppDynamics', 'STRONG', {
      entityType: item.sourceEntityType, entityId: item.id, entityName: item.name,
      sourceSpecificIdentity: { applicationId: item.applicationId || (item.kind === 'application' ? item.id : null),
        tierName: item.tierName, node: item.host, entityKind: item.kind },
      matchingAttributes: [attribute(item.kind || 'entity', value, item.name), ...(clues.environment && item.environment
        ? [attribute('environment', clues.environment, item.environment)] : [])],
      evidenceUsed: [`Exact AppDynamics inventory name ${item.name}.`, 'The complete deterministic clue set selects one current entity.'],
      reasoning: 'A unique AppDynamics inventory entity matches the structured Operations name and environment.', ...context,
    });
  }
  if (compatible.length > 1 || candidates.length > 1) return resultBase('AppDynamics', 'CONFLICT', {
    candidates: (compatible.length ? compatible : candidates).map((item) => ({ id: item.id, name: item.name, type: item.sourceEntityType })),
    evidenceMissing: ['An AppDynamics application, tier, node, or business-transaction discriminator'],
    blocker: 'NO_APPD_ENTITY', reasoning: 'Multiple AppDynamics entities remain compatible with the available Operations clues.', ...context,
  });
  return resultBase('AppDynamics', 'UNKNOWN', {
    evidenceMissing: ['A unique AppDynamics application, tier, node, or business-transaction identity'],
    blocker: 'NO_APPD_ENTITY', reasoning: 'No current AppDynamics entity uniquely matches the available Operations clues.', ...context,
  });
}

function discoverNagios(clues, items, context = {}) {
  const inventory = items.filter((item) => item.id && item.host);
  const hosts = clues.hosts.filter((value) => !isGeneric(value));
  const services = clues.services.filter((value) => !isGeneric(value));
  let candidates = inventory;
  if (hosts.length) candidates = candidates.filter((item) => hosts.some((value) => valuesMatch(value, item.host)));
  if (services.length) candidates = candidates.filter((item) => item.service && services.some((value) => valuesMatch(value, item.service)));
  if (['dc01', 'dc02'].includes(clues.environment)) candidates = candidates.filter((item) => environment(item.instance) === clues.environment);
  const enough = (hosts.length && services.length) || (hosts.length && ['dc01', 'dc02'].includes(clues.environment))
    || (services.length && ['dc01', 'dc02'].includes(clues.environment));
  if (candidates.length === 1 && enough) {
    const item = candidates[0];
    return resultBase('Nagios', 'STRONG', {
      entityType: item.sourceEntityType, entityId: item.id, entityName: item.name,
      sourceSpecificIdentity: { host: item.host, service: item.service, site: item.instance, status: item.status },
      matchingAttributes: [
        ...(hosts.length ? [attribute('host', hosts[0], item.host)] : []),
        ...(services.length ? [attribute('service', services[0], item.service)] : []),
        ...(['dc01', 'dc02'].includes(clues.environment) ? [attribute('site', clues.environment, item.instance)] : []),
      ],
      evidenceUsed: ['The host/service/site combination selects exactly one current Nagios inventory record.'],
      reasoning: 'Nagios identity is unique while preserving DC01/DC02 isolation.', ...context,
    });
  }
  if (candidates.length > 1) return resultBase('Nagios', 'CONFLICT', {
    candidates: candidates.map((item) => ({ id: item.id, host: item.host, service: item.service, site: item.instance })),
    evidenceMissing: [hosts.length ? 'A unique Nagios service/site discriminator' : 'The Nagios host and site'],
    blocker: hosts.length ? 'NO_NAGIOS_SERVICE' : 'NO_NAGIOS_HOST',
    reasoning: 'More than one Nagios record remains compatible; no record was auto-promoted.', ...context,
  });
  return resultBase('Nagios', 'UNKNOWN', {
    evidenceMissing: [hosts.length ? 'A matching Nagios service in the correct site' : 'A deterministic Nagios host'],
    blocker: hosts.length ? 'NO_NAGIOS_SERVICE' : 'NO_NAGIOS_HOST',
    reasoning: 'No unique current Nagios host/service record matches the available Operations clues.', ...context,
  });
}

function discoverThousandEyes(clues, items, context = {}) {
  const tests = items.filter((item) => item.id && item.name);
  const byId = tests.filter((item) => clues.testIds.some((value) => valuesMatch(value, item.testId || item.id)));
  if (byId.length === 1) return resultBase('ThousandEyes', 'EXACT', {
    entityType: 'TEST', entityId: byId[0].id, entityName: byId[0].name,
    sourceSpecificIdentity: { testId: byId[0].testId || byId[0].id, testName: byId[0].name,
      target: byId[0].target, agents: byId[0].agents },
    matchingAttributes: [attribute('testId', clues.testIds[0], byId[0].testId || byId[0].id)],
    evidenceUsed: [`Exact ThousandEyes test ID ${byId[0].id} exists in current inventory.`],
    reasoning: 'The explicit test ID selects one current ThousandEyes test.', ...context,
  });
  const names = clues.testNames.filter((value) => !isGeneric(value));
  let candidates = tests.filter((item) => names.some((value) => valuesMatch(value, item.name)));
  if (!candidates.length && clues.targets.length && clues.agents.length) candidates = tests.filter((item) => (
    clues.targets.some((value) => valuesMatch(value, item.target))
      && clues.agents.some((value) => (item.agents || []).some((agent) => valuesMatch(value, agent)))
  ));
  if (candidates.length === 1 && (names.length || (clues.targets.length && clues.agents.length))) {
    const item = candidates[0];
    return resultBase('ThousandEyes', 'STRONG', {
      entityType: 'TEST', entityId: item.id, entityName: item.name,
      sourceSpecificIdentity: { testId: item.testId || item.id, testName: item.name, target: item.target, agents: item.agents },
      matchingAttributes: names.length ? [attribute('testName', names.find((value) => valuesMatch(value, item.name)), item.name)]
        : [attribute('target', clues.targets[0], item.target), attribute('agent', clues.agents[0], item.agents[0])],
      evidenceUsed: ['The complete ThousandEyes name or target-plus-agent combination selects one current test.'],
      reasoning: 'A unique current ThousandEyes test matches the deterministic Operations clues.', ...context,
    });
  }
  if (candidates.length > 1 || (clues.targets.length && tests.filter((item) => clues.targets.some((value) => valuesMatch(value, item.target))).length > 1)) {
    const ambiguous = candidates.length ? candidates : tests.filter((item) => clues.targets.some((value) => valuesMatch(value, item.target)));
    return resultBase('ThousandEyes', 'CONFLICT', {
      candidates: ambiguous.map((item) => ({ id: item.id, name: item.name, target: item.target })),
      evidenceMissing: ['A unique ThousandEyes test name, test ID, or target-plus-agent combination'],
      blocker: 'NO_THOUSANDEYES_TEST', reasoning: 'The available ThousandEyes target/name is shared by multiple tests.', ...context,
    });
  }
  return resultBase('ThousandEyes', 'UNKNOWN', {
    evidenceMissing: ['A unique ThousandEyes test ID, test name, or target-plus-agent combination'],
    blocker: 'NO_THOUSANDEYES_TEST', reasoning: 'No unique current ThousandEyes test matches the available Operations clues.', ...context,
  });
}

function discoverFromCatalog(input, catalogs) {
  const clues = knownClues(input); const source = clues.source;
  const catalog = catalogs?.sources?.[source];
  const context = { inventoryVersion: catalogs?.version || null, patternKey: stableHash(clues) };
  if (!SUPPORTED_SOURCES.has(source)) return resultBase(source, 'UNSUPPORTED', {
    blocker: 'UNSUPPORTED_SOURCE', evidenceMissing: ['A supported monitoring-source adapter'],
    reasoning: `${source} is not supported by source-side identity discovery.`, ...context,
  });
  if (!catalog?.available && !(catalog?.items || []).length) return resultBase(source, 'UNKNOWN', {
    blocker: 'SOURCE_TELEMETRY_UNAVAILABLE', evidenceMissing: [`Current ${source} inventory`],
    reasoning: `The current ${source} catalog is unavailable; no identity was inferred from absence.`, ...context,
  });
  const items = catalog.items || [];
  if (source === 'Grafana') return discoverGrafana(clues, items, context);
  if (source === 'AppDynamics') return discoverAppDynamics(clues, items, context);
  if (source === 'Nagios') return discoverNagios(clues, items, context);
  return discoverThousandEyes(clues, items, context);
}

function fallbackItems(fallbackInventories, source) {
  const key = source === 'AppDynamics' ? 'appDynamics' : source === 'ThousandEyes' ? 'thousandEyes' : source.toLowerCase();
  return fallbackInventories?.[key]?.items || [];
}

function createSourceSideIdentityDiscoveryService({
  loaders = {
    AppDynamics: loadAppDynamicsCatalog,
    Grafana: loadGrafanaCatalog,
    Nagios: loadNagiosCatalog,
    ThousandEyes: loadThousandEyesCatalog,
  },
  ttlMs = DISCOVERY_TTL_MS, maxConcurrency = 3, now = () => Date.now(),
} = {}) {
  let catalogCache = null; let catalogPromise = null; const patternCache = new Map();

  async function getCatalogs(options = {}) {
    if (!options.refresh && catalogCache && now() - catalogCache.cachedAtMs < ttlMs) {
      return { ...catalogCache.value, cacheHit: true, externalCalls: 0 };
    }
    if (!options.refresh && catalogPromise) return catalogPromise;
    const fallback = options.fallbackInventories || {};
    catalogPromise = mapWithConcurrency([...SUPPORTED_SOURCES], maxConcurrency, async (source) => {
      const loader = loaders[source]; const fallbackCatalog = fallbackItems(fallback, source);
      try {
        const response = await loader(options.refresh === true);
        const normalizer = source === 'Grafana' ? normalizeGrafanaRule : source === 'AppDynamics' ? normalizeAppDynamicsItem
          : source === 'Nagios' ? normalizeNagiosItem : normalizeThousandEyesItem;
        const items = mergeCatalog(response.items || [], fallbackCatalog, normalizer);
        return [source, { available: true, items, pages: Number(response.pages || 1), source: 'existing_source_service', error: null }];
      } catch (error) {
        const items = fallbackCatalog;
        return [source, { available: items.length > 0, items, pages: 0, source: items.length ? 'existing_synchronized_inventory' : 'unavailable',
          error: safeCode(error, `${normalize(source).toUpperCase()}_CATALOG_UNAVAILABLE`) }];
      }
    }).then((rows) => {
      const sources = Object.fromEntries(rows);
      const value = {
        sources,
        version: stableHash(Object.entries(sources).map(([source, catalog]) => [source,
          catalog.items.map((item) => [item.sourceEntityType || item.kind, catalogItemId(item), item.lastValidatedAt || null])])),
        counts: Object.fromEntries(Object.entries(sources).map(([source, catalog]) => [source, catalog.items.length])),
        maxConcurrency, cacheTtlMs: ttlMs, cacheHit: false, externalCalls: rows.length,
        readOnly: true, externalMutations: 'none', loadedAt: new Date(now()).toISOString(),
      };
      catalogCache = { cachedAtMs: now(), value }; return value;
    }).finally(() => { catalogPromise = null; });
    return catalogPromise;
  }

  function discover(input, catalogs) {
    const clues = knownClues(input); const patternKey = stableHash(clues);
    const key = `${catalogs?.version || 'none'}:${patternKey}`;
    const cached = patternCache.get(key);
    if (cached && ACCEPTED_STATES.has(cached.discoveryState)) return { ...cached, cacheHit: true };
    const result = discoverFromCatalog(input, catalogs);
    if (ACCEPTED_STATES.has(result.discoveryState)) patternCache.set(key, result);
    return result;
  }

  function clearCache() { catalogCache = null; patternCache.clear(); }

  return { clearCache, discover, getCatalogs, maxConcurrency, ttlMs };
}

module.exports = {
  ACCEPTED_STATES,
  GENERIC_VALUES,
  canonicalSource,
  createSourceSideIdentityDiscoveryService,
  discoverAppDynamics,
  discoverFromCatalog,
  discoverGrafana,
  discoverNagios,
  discoverThousandEyes,
  knownClues,
  normalize,
  service: createSourceSideIdentityDiscoveryService(),
};
