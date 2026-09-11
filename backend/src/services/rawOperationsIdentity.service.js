const SENSITIVE_KEY = /(authorization|cookie|credential|password|passwd|secret|token|api.?key|client.?secret|signing.?secret|verification.?token)/i;
const URL_VALUE = /https?:\/\/[^\s<>"')\]]+/gi;
const SINGLETON_ID_FIELDS = new Set([
  'applicationIds', 'tierIds', 'nodeIds', 'businessTransactionIds',
  'healthRuleIds', 'policyIds', 'ruleUids', 'testIds',
]);

const EXTRACTED_FIELDS = Object.freeze([
  'sourceEntityIds', 'sourceEntityNames', 'applicationIds', 'applicationNames',
  'tierIds', 'tierNames', 'nodeIds', 'nodeNames', 'businessTransactionIds',
  'businessTransactionNames', 'healthRuleIds', 'healthRuleNames', 'policyIds',
  'policyNames', 'eventIds', 'violationIds', 'ruleUids', 'ruleNames',
  'dashboardUids', 'panelIds', 'datasourceIds', 'hostIds', 'hostNames',
  'serviceIds', 'serviceNames', 'testIds', 'targets', 'agents',
  'environmentNames', 'instances', 'deepLinks',
]);

function clean(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function unique(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function emptyExtracted() {
  return Object.fromEntries(EXTRACTED_FIELDS.map((field) => [field, []]));
}

function provenanceType(path) {
  if (/deep.?link|source.?url|event.?link|permalink|href|url/i.test(path)) return 'DEEP_LINK';
  if (/(^|\.)(labels?)(\.|\[|$)/i.test(path)) return 'LABEL';
  if (/(^|\.)(tags?)(\.|\[|$)/i.test(path)) return 'TAG';
  if (/(^|\.)(annotations?)(\.|\[|$)/i.test(path)) return 'ANNOTATION';
  if (/source.?metadata|integration|source.?details|extra.?properties/i.test(path)) return 'SOURCE_METADATA';
  return 'STRUCTURED_FIELD';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    [...url.searchParams.keys()].forEach((key) => {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[redacted]');
    });
    return url.toString();
  } catch {
    return null;
  }
}

function redactRawPayload(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12) return '[depth-limited]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const directUrl = safeUrl(value);
    return directUrl || value;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactRawPayload(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : redactRawPayload(item, depth + 1, seen),
  ]));
}

function decodeVariants(value) {
  const output = [clean(value)];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = output.at(-1);
    try {
      const decoded = decodeURIComponent(previous);
      if (!decoded || decoded === previous) break;
      output.push(decoded);
    } catch { break; }
  }
  const candidate = output.at(-1);
  if (/^[A-Za-z0-9+/_=-]{16,}$/.test(candidate)) {
    try {
      const decoded = Buffer.from(candidate.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) output.push(decoded);
    } catch { /* A base64-like value is ignored unless it decodes to a URL. */ }
  }
  return unique(output);
}

function extractUrls(value, output = [], depth = 0, path = 'payload', seen = new WeakSet()) {
  if (value === null || value === undefined || depth > 12 || output.length >= 300) return output;
  if (typeof value === 'string') {
    decodeVariants(value).forEach((decoded) => {
      const matches = /^https?:\/\//i.test(decoded) ? [decoded] : (decoded.match(URL_VALUE) || []);
      unique(matches).forEach((url) => {
        const sanitized = safeUrl(url.replace(/[.,;:]$/, ''));
        if (sanitized) output.push({ value: sanitized, path });
      });
    });
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((item, index) => extractUrls(item, output, depth + 1, `${path}[${index}]`, seen));
  } else {
    Object.entries(value).slice(0, 1000).forEach(([key, item]) => {
      if (!SENSITIVE_KEY.test(key)) extractUrls(item, output, depth + 1, `${path}.${key}`, seen);
    });
  }
  return output;
}

function genericDeepLink(urlValue) {
  const sanitized = safeUrl(urlValue);
  if (!sanitized) return null;
  const url = new URL(sanitized);
  const query = {};
  url.searchParams.forEach((value, key) => {
    if (!SENSITIVE_KEY.test(key)) query[key] = decodeVariants(value).at(-1);
  });
  return {
    url: sanitized,
    hostname: url.hostname.toLowerCase(),
    path: url.pathname.split('/').filter(Boolean).map((item) => decodeVariants(item).at(-1)),
    query,
    fragment: decodeVariants(url.hash.replace(/^#/, '')).at(-1) || null,
  };
}

function parameter(generic, names) {
  const entries = Object.entries(generic?.query || {});
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match && clean(match[1])) return clean(match[1]);
  }
  return null;
}

function pathAfter(generic, names, skip = []) {
  const segments = generic?.path || [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!names.some((name) => segments[index].toLowerCase() === name.toLowerCase())) continue;
    const remaining = segments.slice(index + 1).filter((item) => !skip.includes(item.toLowerCase()));
    if (remaining[0]) return remaining[0];
  }
  return null;
}

function extractAppDynamicsIdentity(generic) {
  if (!generic || !/(appdynamics|appd)/i.test(`${generic.hostname}/${generic.path.join('/')}`)) return {};
  return {
    applicationIds: unique([parameter(generic, ['application', 'applicationId', 'application-id']), pathAfter(generic, ['applications'])]),
    tierIds: unique([parameter(generic, ['tier', 'tierId', 'tier-id']), pathAfter(generic, ['tiers'])]),
    nodeIds: unique([parameter(generic, ['node', 'nodeId', 'node-id']), pathAfter(generic, ['nodes'])]),
    businessTransactionIds: unique([parameter(generic, ['businessTransaction', 'businessTransactionId', 'btId']), pathAfter(generic, ['business-transactions', 'businessTransactions'])]),
    healthRuleIds: unique([parameter(generic, ['healthRule', 'healthRuleId']), pathAfter(generic, ['health-rules', 'healthRules'])]),
    policyIds: unique([parameter(generic, ['policy', 'policyId']), pathAfter(generic, ['policies'])]),
    eventIds: unique([parameter(generic, ['event', 'eventId']), pathAfter(generic, ['events'])]),
    violationIds: unique([parameter(generic, ['violation', 'violationId']), pathAfter(generic, ['violations'])]),
  };
}

function extractGrafanaIdentity(generic) {
  if (!generic || !/grafana/i.test(`${generic.hostname}/${generic.path.join('/')}`)) return {};
  const alertingIndex = generic.path.findIndex((item) => item.toLowerCase() === 'alerting');
  const rulePath = alertingIndex >= 0
    ? generic.path.slice(alertingIndex + 1).find((item) => ![
      'grafana', 'list', 'new', 'view', 'edit', 'silence', 'silences',
    ].includes(item.toLowerCase()))
    : null;
  return {
    ruleUids: unique([parameter(generic, ['ruleUid', 'rule_uid', 'alertRuleUid']), rulePath]),
    dashboardUids: unique([parameter(generic, ['dashboardUid', 'dashboard']), pathAfter(generic, ['d', 'dashboard', 'dashboards'])]),
    panelIds: unique([parameter(generic, ['viewPanel', 'panelId', 'panel'])]),
    datasourceIds: unique([parameter(generic, ['datasourceUid', 'datasource', 'dsUid'])]),
  };
}

function extractNagiosIdentity(generic) {
  if (!generic || !/nagios/i.test(`${generic.hostname}/${generic.path.join('/')}`)) return {};
  return {
    hostNames: unique([parameter(generic, ['host', 'host_name', 'hostName'])]),
    serviceNames: unique([parameter(generic, ['service', 'service_description', 'serviceDescription'])]),
    hostIds: unique([parameter(generic, ['hostId', 'host_id'])]),
    serviceIds: unique([parameter(generic, ['serviceId', 'service_id'])]),
    environmentNames: unique([`${generic.hostname}/${generic.path.join('/')}`.match(/\b(dc0?1|dc0?2)\b/i)?.[1]]),
  };
}

function extractThousandEyesIdentity(generic) {
  if (!generic || !/thousandeyes/i.test(`${generic.hostname}/${generic.path.join('/')}`)) return {};
  return {
    testIds: unique([parameter(generic, ['testId', 'test']), pathAfter(generic, ['tests'])]),
    sourceEntityIds: unique([parameter(generic, ['alertId', 'alert']), pathAfter(generic, ['alerts'])]),
    agents: unique([parameter(generic, ['agentId', 'agent'])]),
  };
}

const FIELD_RULES = Object.freeze([
  ['sourceEntityIds', /^(sourceEntityId|sourceObjectId|monitoringEntityId)$/i],
  ['sourceEntityNames', /^(sourceEntityName|entityName)$/i],
  ['applicationIds', /^(applicationId|appId|application_id)$/i],
  ['applicationNames', /^(applicationName|appName|application_name|application)$/i],
  ['tierIds', /^(tierId|tier_id)$/i], ['tierNames', /^(tierName|tier_name|tier)$/i],
  ['nodeIds', /^(nodeId|node_id)$/i], ['nodeNames', /^(nodeName|node_name|node)$/i],
  ['businessTransactionIds', /^(businessTransactionId|business_transaction_id|btId)$/i],
  ['businessTransactionNames', /^(businessTransactionName|business_transaction_name|businessTransaction|btName)$/i],
  ['healthRuleIds', /^(healthRuleId|health_rule_id)$/i], ['healthRuleNames', /^(healthRuleName|health_rule_name|healthRule)$/i],
  ['policyIds', /^(policyId|policy_id)$/i], ['policyNames', /^(policyName|policy_name|policy)$/i],
  ['eventIds', /^(eventId|event_id)$/i], ['violationIds', /^(violationId|violation_id|violationAlias)$/i],
  ['ruleUids', /^(ruleUid|rule_uid|alertRuleUid|alert_rule_uid)$/i], ['ruleNames', /^(ruleName|rule_name|alertName|alertname|alertRuleName)$/i],
  ['dashboardUids', /^(dashboardUid|dashboard_uid)$/i], ['panelIds', /^(panelId|panel_id|viewPanel)$/i],
  ['datasourceIds', /^(datasourceUid|datasourceId|datasource_uid|datasource_id)$/i],
  ['hostIds', /^(hostId|host_id)$/i], ['hostNames', /^(host|hostname|hostName|host_name)$/i],
  ['serviceIds', /^(serviceId|service_id)$/i], ['serviceNames', /^(service|serviceName|service_name|serviceDescription|service_description)$/i],
  ['testIds', /^(testId|test_id)$/i], ['targets', /^(target|targetName|target_name|serverName|server_name)$/i],
  ['agents', /^(agent|agentId|agentName|agent_id|agent_name)$/i],
  ['environmentNames', /^(environment|environmentName|environment_name|env|site|datacenter|dataCenter)$/i],
  ['instances', /^(instance|instanceName|instance_name|pod|namespace|deployment|job)$/i],
]);

function extractRawOperationsIdentity(payload = {}, options = {}) {
  const redacted = redactRawPayload(payload);
  const extracted = emptyExtracted();
  const provenance = [];
  const fieldsSearched = [];
  const add = (field, value, path, type = provenanceType(path)) => {
    if (!EXTRACTED_FIELDS.includes(field) || value === null || value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item) => {
      const cleaned = clean(item);
      if (!cleaned || cleaned === '[redacted]') return;
      if (!extracted[field].includes(cleaned)) extracted[field].push(cleaned);
      if (!provenance.some((entry) => entry.field === field && entry.value === cleaned && entry.source === path)) {
        provenance.push({ value: cleaned, field, source: path, provenanceType: type });
      }
    });
  };
  const visit = (value, path = 'payload', depth = 0, seen = new WeakSet()) => {
    if (!value || depth > 12 || provenance.length >= 800) return;
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 500).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, seen));
      return;
    }
    Object.entries(value).slice(0, 1000).forEach(([key, item]) => {
      const itemPath = `${path}.${key}`;
      if (SENSITIVE_KEY.test(key)) return;
      fieldsSearched.push(itemPath);
      if (['string', 'number'].includes(typeof item)) {
        for (const [field, pattern] of FIELD_RULES) if (pattern.test(key)) add(field, item, itemPath);
        if (/^(tag|tags)$/i.test(key) && typeof item === 'string') {
          const match = item.match(/^\s*([^:=]+)\s*[:=]\s*(.+)$/);
          if (match) {
            for (const [field, pattern] of FIELD_RULES) if (pattern.test(match[1])) add(field, match[2], itemPath, 'TAG');
          }
        }
      }
      if (/^(tag|tags)$/i.test(key) && Array.isArray(item)) {
        item.filter((tag) => typeof tag === 'string').forEach((tag, index) => {
          const match = tag.match(/^\s*([^:=]+)\s*[:=]\s*(.+)$/);
          if (!match) return;
          for (const [field, pattern] of FIELD_RULES) {
            if (pattern.test(match[1])) add(field, match[2], `${itemPath}[${index}]`, 'TAG');
          }
        });
      }
      visit(item, itemPath, depth + 1, seen);
    });
  };
  visit(redacted);

  const urls = extractUrls(redacted);
  urls.forEach(({ value, path }) => {
    add('deepLinks', value, path, 'DEEP_LINK');
    const generic = genericDeepLink(value);
    const parsers = [
      extractAppDynamicsIdentity(generic), extractGrafanaIdentity(generic),
      extractNagiosIdentity(generic), extractThousandEyesIdentity(generic),
    ];
    parsers.forEach((result) => Object.entries(result).forEach(([field, values]) => (
      add(field, values, `${path}.${generic?.hostname || 'url'}`, 'DEEP_LINK')
    )));
  });

  const conflicts = [];
  SINGLETON_ID_FIELDS.forEach((field) => {
    const values = unique(extracted[field]);
    if (values.length <= 1) return;
    conflicts.push({
      field,
      values,
      reason: `Conflicting deterministic ${field} were extracted from one Operations alert.`,
      provenance: provenance.filter((entry) => entry.field === field),
    });
  });
  const ids = ['sourceEntityIds', 'applicationIds', 'tierIds', 'nodeIds', 'businessTransactionIds',
    'healthRuleIds', 'policyIds', 'eventIds', 'violationIds', 'ruleUids', 'dashboardUids',
    'panelIds', 'datasourceIds', 'hostIds', 'serviceIds', 'testIds'];
  const names = ['sourceEntityNames', 'applicationNames', 'tierNames', 'nodeNames',
    'businessTransactionNames', 'healthRuleNames', 'policyNames', 'ruleNames', 'hostNames',
    'serviceNames', 'targets', 'agents', 'environmentNames', 'instances'];
  const valueCount = EXTRACTED_FIELDS.reduce((sum, field) => sum + extracted[field].length, 0);
  const source = clean(options.source || payload.sourceSystem || payload.source || payload.integrationName) || 'Unknown';
  return {
    alertId: clean(options.alertId || payload.id || payload.alertId) || null,
    source,
    extracted,
    provenance,
    extractionConfidence: conflicts.length ? 'CONFLICT'
      : ids.some((field) => extracted[field].length) ? 'EXACT'
        : names.some((field) => extracted[field].length) ? 'STRONG' : 'UNKNOWN',
    conflicts,
    fieldsSearched: unique(fieldsSearched),
    fieldsFound: unique(provenance.map((entry) => entry.source)),
    fieldsMissing: ids.filter((field) => !extracted[field].length),
    valueCount,
    rawPayloadRedacted: true,
    externalMutations: 'none',
  };
}

function summarizeExtractions(extractions = []) {
  const total = extractions.length;
  const coverageFields = ['applicationIds', 'nodeIds', 'ruleUids', 'dashboardUids', 'hostNames', 'serviceNames', 'testIds', 'deepLinks'];
  const fieldCoverage = Object.fromEntries(coverageFields.map((field) => {
    const count = extractions.filter((item) => item?.extracted?.[field]?.length).length;
    return [field, { count, percentage: total ? Number((count / total * 100).toFixed(1)) : 0 }];
  }));
  const provenanceCounts = { RAW_PAYLOAD: 0, STRUCTURED_FIELD: 0, TAG: 0, LABEL: 0, ANNOTATION: 0, DEEP_LINK: 0, URL_QUERY: 0, URL_PATH: 0, SOURCE_METADATA: 0, EXISTING_MAPPING: 0 };
  extractions.flatMap((item) => item?.provenance || []).forEach((entry) => {
    const type = entry.provenanceType || 'RAW_PAYLOAD';
    provenanceCounts[type] = (provenanceCounts[type] || 0) + 1;
  });
  return {
    alertsInspected: total,
    valuesExtracted: extractions.reduce((sum, item) => sum + Number(item?.valueCount || 0), 0),
    fieldCoverage,
    provenanceCounts,
    conflicts: extractions.reduce((sum, item) => sum + (item?.conflicts?.length || 0), 0),
    redactionApplied: true,
  };
}

module.exports = {
  EXTRACTED_FIELDS,
  SENSITIVE_KEY,
  extractAppDynamicsIdentity,
  extractGrafanaIdentity,
  extractNagiosIdentity,
  extractRawOperationsIdentity,
  extractThousandEyesIdentity,
  genericDeepLink,
  redactRawPayload,
  safeUrl,
  summarizeExtractions,
};
