const crypto = require('crypto');
const db = require('../config/db');
const {
  notEvaluatedMetadata,
  unclassifiedFoundationState,
} = require('../config/decisionLayer');
const abcHubService = require('./abcHub.service');
const appDynamicsService = require('./appDynamics.service');
const integrationService = require('./integration.service');
const nagiosService = require('./nagios.service');
const paymentGatewayService = require('./paymentGateway.service');
const thousandEyesService = require('./thousandEyes.service');
const {
  getMonitoringSourceDefinition,
  getMonitoringSourceDefinitions,
  sourceMatchesDefinition,
} = require('./monitoringSources');

const INGESTION_TIMEOUT_MS = 10000;

const monitoringSourceDefinitions = getMonitoringSourceDefinitions();
const toolLabels = Object.fromEntries(
  monitoringSourceDefinitions.flatMap((definition) => [
    [definition.id, definition.label],
    [definition.integrationTool, definition.label],
  ]),
);

const nagiosInstanceBySource = {
  'nagios-dc01': 'd01',
  'nagios-dc02': 'd02',
};

function normalizeBaseUrl(baseUrl) {
  return baseUrl?.trim()?.replace(/\/+$/, '') || null;
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return null;
  }

  return new URL(path, `${normalizedBaseUrl}/`).toString();
}

function isNagiosSource(sourceKey) {
  return Boolean(nagiosInstanceBySource[sourceKey]);
}

function normalizeNagiosPollResult(result, definition, mode) {
  const stored = Number(result.stored || 0);
  const problems = Number(result.problems || 0);

  return {
    ...result,
    tool: definition.id,
    label: definition.label,
    fetched: Number(result.fetched || 0),
    rawStored: stored,
    inserted: 0,
    updated: stored,
    skipped: 0,
    alertIds: [],
    mode,
    message: `${definition.label} sync complete: ${stored} Nagios records stored, ${problems} active problems found.`,
  };
}

function buildThousandEyesUrls(baseUrl, accountGroupId) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return [];
  }

  const suffix = accountGroupId ? `?aid=${encodeURIComponent(accountGroupId)}` : '';

  try {
    const url = new URL(normalizedBaseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    const hasVersionPath = /\/v\d+$/i.test(path);
    const candidates = hasVersionPath
      ? [`alerts${suffix}`]
      : [`v7/alerts${suffix}`, `alerts${suffix}`];

    return [...new Set(candidates.map((candidate) => new URL(candidate, `${normalizedBaseUrl}/`).toString()))];
  } catch {
    return [];
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INGESTION_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    });
    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getNetworkMessage(vendorName, error) {
  const code = error.cause?.code || error.code;

  if (error.name === 'AbortError') {
    return `${vendorName} ingestion timed out. Check VPN, proxy, or API reachability.`;
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return `${vendorName} SSL certificate could not be verified. Use NODE_EXTRA_CA_CERTS or local demo SSL bypass.`;
  }

  return `Unable to ingest from ${vendorName}. ${code ? `Error: ${code}.` : error.message}`;
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16).toUpperCase();
}

function toArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter((item) => item !== null && item !== undefined && item !== '');
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [value];
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function removeUndefinedValues(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function buildCustomProperties(item, normalizedAlert) {
  const knownKeys = new Set([
    'acknowledged',
    'acknowledgedAt',
    'acknowledged_at',
    'acknowledgedBy',
    'acknowledged_by',
    'alert_id',
    'alertId',
    'alertName',
    'alert_name',
    'application',
    'app',
    'controllerUrl',
    'controller_url',
    'createdAt',
    'created_at',
    'dashboardUrl',
    'dashboard_url',
    'deepEventLink',
    'deep_event_link',
    'description',
    'details',
    'entity',
    'environment',
    'eventDeepLink',
    'event_deep_link',
    'eventLink',
    'event_link',
    'healthRule',
    'health_rule',
    'healthRuleId',
    'health_rule_id',
    'host',
    'hostname',
    'id',
    'labels',
    'lastSeen',
    'message',
    'name',
    'owner',
    'priority',
    'responders',
    'service',
    'severity',
    'source',
    'sourceInstance',
    'source_instance',
    'sourceTool',
    'source_tool',
    'startedAt',
    'startTime',
    'status',
    'summary',
    'tags',
    'timestamp',
    'title',
    'updatedAt',
    'updated_at',
    'url',
  ]);
  const customProperties = {};

  Object.entries(item || {}).forEach(([key, value]) => {
    if (!knownKeys.has(key)) {
      customProperties[key] = value;
    }
  });

  return {
    ...customProperties,
    ...(item?.custom_properties || {}),
    ...(item?.customProperties || {}),
    source_tool: normalizedAlert.source_tool,
    source_instance: normalizedAlert.source_instance,
  };
}

function buildExtractedDetails(item, normalizedAlert) {
  const customProperties = buildCustomProperties(item, normalizedAlert);

  return {
    normalized_alert: normalizedAlert,
    custom_properties: customProperties,
    classification: notEvaluatedMetadata(),
  };
}

async function ensureSourceStorage(client = db) {
  await client.query(`
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'monitoring';
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_alert_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS extracted_details JSONB;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS responders JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS confidence_score INTEGER;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS duplicate_signature TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS correlation_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS classification_is_legacy BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_classification_check;
    ALTER TABLE alerts
      ADD CONSTRAINT alerts_classification_check
      CHECK (classification IN ('incident', 'noise', 'needs_review', 'unclassified'));
    ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_status_check;
    ALTER TABLE alerts
      ADD CONSTRAINT alerts_status_check
      CHECK (status IN ('open', 'acknowledged', 'escalated', 'investigating', 'suppressed', 'auto-resolved', 'deduplicated', 'firing', 'triggered', 'resolved', 'recovered', 'closed'));

    CREATE TABLE IF NOT EXISTS raw_alerts (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'monitoring',
      source_alert_id TEXT,
      normalized_alert_id TEXT REFERENCES alerts(id) ON DELETE SET NULL,
      raw_payload JSONB NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'stored',
      error_message TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE raw_alerts DROP CONSTRAINT IF EXISTS raw_alerts_processing_status_check;
    ALTER TABLE raw_alerts
      ADD CONSTRAINT raw_alerts_processing_status_check
      CHECK (processing_status IN ('stored', 'normalized', 'normalization_failed', 'classification_failed'));

    CREATE TABLE IF NOT EXISTS alert_classification_history (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      classification TEXT NOT NULL,
      noise_type TEXT NOT NULL DEFAULT 'none',
      confidence_score INTEGER,
      justification TEXT NOT NULL,
      noise_reason TEXT,
      classified_by TEXT NOT NULL DEFAULT 'system',
      classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_correlation_history (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      duplicate_signature TEXT,
      correlation_id TEXT,
      duplicate_count INTEGER NOT NULL DEFAULT 1,
      related_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_incident_mappings (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      incident_id BIGINT REFERENCES incidents(id) ON DELETE CASCADE,
      jira_ticket_id TEXT,
      mapping_reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS monitoring_source_status (
      source_key TEXT PRIMARY KEY,
      adapter_name TEXT NOT NULL,
      connection_status TEXT NOT NULL DEFAULT 'not_configured',
      api_health TEXT NOT NULL DEFAULT 'not_configured',
      sync_status TEXT NOT NULL DEFAULT 'idle',
      last_successful_sync TIMESTAMPTZ,
      last_failed_sync TIMESTAMPTZ,
      last_alert_received_at TIMESTAMPTZ,
      total_alerts_imported INTEGER NOT NULL DEFAULT 0,
      last_sync_duration_ms INTEGER,
      response_time_ms INTEGER,
      last_error TEXT,
      sync_cursor TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_monitoring_source_status_updated
      ON monitoring_source_status(updated_at DESC);
  `);

  for (const definition of monitoringSourceDefinitions) {
    await client.query(
      `
        INSERT INTO monitoring_source_status (source_key, adapter_name, metadata)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (source_key)
        DO UPDATE SET
          adapter_name = EXCLUDED.adapter_name,
          metadata = monitoring_source_status.metadata || EXCLUDED.metadata,
          updated_at = NOW()
      `,
      [
        definition.id,
        definition.adapterName,
        JSON.stringify({
          label: definition.label,
          integrationTool: definition.integrationTool,
          category: definition.category,
        }),
      ],
    );
  }
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toLowerCase();

  if (['critical', 'crit', 'p1', 'sev1'].includes(normalized)) {
    return 'critical';
  }

  if (['high', 'p2', 'sev2', 'major'].includes(normalized)) {
    return 'high';
  }

  if (['warning', 'warn'].includes(normalized)) {
    return 'warning';
  }

  if (['low', 'info', 'informational'].includes(normalized)) {
    return 'low';
  }

  return 'medium';
}

function normalizeEnvironment(value) {
  const normalized = String(value || '').toLowerCase();

  if (['prod', 'production'].includes(normalized)) {
    return 'production';
  }

  if (normalized.includes('stag')) {
    return 'staging';
  }

  if (['dev', 'development', 'test'].includes(normalized)) {
    return 'development';
  }

  return 'unknown';
}

function normalizeStatus(value, fallback = 'open') {
  const normalized = String(value || '').toLowerCase();

  if (['firing', 'alerting', 'active', 'triggered'].includes(normalized)) {
    return 'firing';
  }

  if (['resolved', 'ok', 'normal', 'recovered', 'closed'].includes(normalized)) {
    return 'resolved';
  }

  if (['suppressed', 'silenced'].includes(normalized)) {
    return 'suppressed';
  }

  return fallback;
}

function buildDuplicateSignature(alert) {
  return crypto
    .createHash('sha1')
    .update([
      alert.source,
      alert.service,
      alert.environment,
      alert.severity,
      alert.title,
    ].map((value) => String(value || '').trim().toLowerCase()).join('|'))
    .digest('hex');
}

function finalizeNormalizedAlert(alert) {
  const definition = getMonitoringSourceDefinition(alert.source) || getMonitoringSourceDefinition(alert.sourceTool);
  const source = definition?.id || String(alert.source || alert.sourceTool || 'unknown-source').toLowerCase();
  const sourceInstance = alert.sourceInstance || definition?.sourceInstance || source;
  const tags = toArray(alert.tags);
  const labels = alert.labels && typeof alert.labels === 'object' && !Array.isArray(alert.labels)
    ? { ...alert.labels }
    : {};
  const responders = toArray(alert.responders);
  const normalizedAlert = removeUndefinedValues({
    alert_id: alert.sourceAlertId || alert.id,
    source_tool: source,
    source_name: definition?.label || toolLabels[source] || source,
    source_instance: sourceInstance,
    application: alert.application || alert.service,
    service: alert.service,
    entity: alert.entity || alert.service,
    summary: alert.title,
    description: alert.description,
    priority: alert.priority || alert.severity,
    severity: alert.severity,
    status: alert.status,
    created_at: alert.receivedAt,
    updated_at: alert.lastSeenAt,
    acknowledged: Boolean(alert.acknowledged),
    acknowledged_by: alert.acknowledgedBy || null,
    acknowledged_at: alert.acknowledgedAt || null,
    tags,
    labels,
    owner: alert.owner,
    responders,
    event_link: alert.eventLink || alert.sourceUrl || null,
    deep_event_link: alert.deepEventLink || alert.sourceUrl || null,
    dashboard_url: alert.dashboardUrl || null,
    health_rule: alert.healthRule || alert.healthRuleId || null,
    controller_url: alert.controllerUrl || null,
  });

  const foundationState = unclassifiedFoundationState();

  return {
    ...alert,
    source,
    sourceInstance,
    tags,
    labels,
    responders,
    ...foundationState,
    duplicateSignature: alert.duplicateSignature || buildDuplicateSignature({ ...alert, source }),
    correlationId: alert.correlationId || alert.sourceAlertId || alert.id,
    relatedAlerts: alert.relatedAlerts || [],
    sourceType: alert.sourceType || 'monitoring',
    sourceAlertId: alert.sourceAlertId || alert.id,
    extractedDetails: alert.extractedDetails || buildExtractedDetails(alert.rawPayload || {}, normalizedAlert),
  };
}

function normalizeGrafanaAlert(item) {
  const labels = item.labels || {};
  const annotations = item.annotations || {};
  const statusValue = item.status?.state || item.status || labels.alertstate || labels.state;
  const status = normalizeStatus(statusValue, 'firing');
  const title = annotations.summary || annotations.title || labels.alertname || labels.rule_uid || 'Grafana alert';
  const service = labels.service || labels.job || labels.app || labels.namespace || 'unknown-service';
  const environment = normalizeEnvironment(labels.environment || labels.env || labels.tier);
  const severity = normalizeSeverity(labels.severity || labels.priority);
  const externalId = labels.alertname || labels.rule_uid || item.fingerprint || item.startsAt || title;

  return finalizeNormalizedAlert({
    id: `GRAFANA-${hashId(`${service}:${environment}:${externalId}`)}`,
    title,
    application: labels.application || labels.app || service,
    service,
    entity: labels.instance || labels.pod || labels.host || service,
    environment,
    priority: labels.priority || labels.severity,
    severity,
    status,
    source: 'grafana',
    sourceInstance: labels.grafana_folder || labels.org || 'grafana',
    sourceType: 'monitoring',
    sourceAlertId: String(externalId),
    sourceUrl: item.generatorURL || item.dashboardURL || item.panelURL || null,
    eventLink: item.generatorURL || item.dashboardURL || item.panelURL || null,
    deepEventLink: item.generatorURL || item.dashboardURL || item.panelURL || null,
    dashboardUrl: item.dashboardURL || annotations.dashboard_url || annotations.dashboardUrl || null,
    rawPayload: item,
    receivedAt: item.startsAt || new Date().toISOString(),
    lastSeenAt: item.updatedAt || item.endsAt || new Date().toISOString(),
    owner: labels.owner || labels.team || 'Unassigned',
    responders: labels.responders,
    tags: item.tags || labels.tags,
    labels,
    signal: title,
    description: annotations.description || annotations.message || `Grafana alert from ${service}.`,
  });
}

function getGrafanaItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.alerts)) {
    return payload.alerts;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

function getThousandEyesItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.alerts)) {
    return payload.alerts;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

function normalizeThousandEyesAlert(item) {
  const rule = item.rule || item.alertRule || {};
  const test = item.test || {};
  const status = normalizeStatus(item.state || item.status || item.alertState, 'firing');
  const title = item.alertName || item.ruleName || rule.name || item.name || 'ThousandEyes alert';
  const service = test.name || item.testName || item.agentName || item.target || 'thousandeyes-test';
  const severity = normalizeSeverity(item.severity || item.priority);
  const externalId = item.id || item.alertId || item.alertGroupId || item.permalink || title;

  return finalizeNormalizedAlert({
    id: `TE-${hashId(`${service}:${externalId}`)}`,
    title,
    application: item.application || item.app || service,
    service,
    entity: item.entity || item.agentName || item.target || service,
    environment: normalizeEnvironment(item.environment || item.env),
    priority: item.priority || item.severity,
    severity,
    status,
    source: 'thousandeyes',
    sourceInstance: item.accountGroupName || item.accountGroupId || 'global',
    sourceType: 'monitoring',
    sourceAlertId: String(externalId),
    sourceUrl: item.permalink || item.url || null,
    eventLink: item.permalink || item.url || null,
    deepEventLink: item.permalink || item.url || null,
    dashboardUrl: item.dashboardUrl || item.dashboard_url || null,
    rawPayload: item,
    receivedAt: item.firstSeen || item.startDate || item.createdAt || new Date().toISOString(),
    lastSeenAt: item.lastSeen || item.endDate || item.updatedAt || new Date().toISOString(),
    owner: item.owner || rule.owner || 'Network Ops',
    responders: item.responders,
    tags: item.tags,
    labels: item.labels,
    signal: title,
    description: item.details || item.description || `ThousandEyes alert from ${service}.`,
  });
}

function normalizeGenericSourceAlert(sourceTool, item) {
  const labels = item.labels && typeof item.labels === 'object' && !Array.isArray(item.labels) ? item.labels : {};
  const sourceDefinition = getMonitoringSourceDefinition(sourceTool || item.source_tool || item.sourceTool || item.source);
  const source = sourceDefinition?.id || String(sourceTool || item.source || item.sourceTool || 'unknown-source').toLowerCase();
  const title =
    item.alertName ||
    item.alert_name ||
    item.title ||
    item.name ||
    item.message ||
    labels.alertname ||
    `${toolLabels[source] || sourceTool} alert`;
  const service =
    item.service ||
    item.application ||
    item.app ||
    item.host ||
    item.hostname ||
    labels.service ||
    labels.application ||
    labels.host ||
    'unknown-service';
  const environment = normalizeEnvironment(item.environment || item.env || labels.environment || labels.env);
  const sourceAlertId =
    item.alertId ||
    item.alert_id ||
    item.eventId ||
    item.event_id ||
    item.problemId ||
    item.problem_id ||
    item.id ||
    item.guid ||
    `${service}:${title}:${item.timestamp || item.createdAt || item.startedAt || ''}`;
  const severity = normalizeSeverity(item.severity || item.priority || item.state || item.level);
  const status = normalizeStatus(item.status || item.state || item.eventType || item.event_type, 'open');
  const receivedAt = item.timestamp || item.createdAt || item.created_at || item.startedAt || item.startTime || new Date().toISOString();
  const lastSeenAt = item.updatedAt || item.updated_at || item.lastSeen || item.endTime || receivedAt;
  const sourceUrl = firstValue(
    item.deep_event_link,
    item.deepEventLink,
    item.event_deep_link,
    item.eventDeepLink,
    item.event_link,
    item.eventLink,
    item.url,
    item.permalink,
  );

  return finalizeNormalizedAlert({
    id: `${source.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${hashId(sourceAlertId)}`,
    title,
    application: item.application || item.app || labels.application || labels.app || service,
    service,
    entity: item.entity || item.host || item.hostname || labels.entity || labels.host || service,
    environment,
    priority: item.priority || item.severity || item.level,
    severity,
    status,
    source,
    sourceInstance: item.source_instance || item.sourceInstance || labels.source_instance || sourceDefinition?.sourceInstance,
    sourceType: 'monitoring',
    sourceAlertId: String(sourceAlertId),
    sourceUrl,
    eventLink: item.event_link || item.eventLink || sourceUrl,
    deepEventLink: item.deep_event_link || item.deepEventLink || item.event_deep_link || item.eventDeepLink || sourceUrl,
    dashboardUrl: item.dashboard_url || item.dashboardUrl || item.dashboard,
    healthRule: item.health_rule || item.healthRule || item.health_rule_id || item.healthRuleId,
    controllerUrl: item.controller_url || item.controllerUrl,
    rawPayload: item,
    receivedAt,
    lastSeenAt,
    owner: item.owner || item.team || labels.owner || labels.team || 'Unassigned',
    responders: item.responders || item.people?.responders || labels.responders,
    tags: item.tags || labels.tags,
    labels,
    signal: item.message || item.summary || title,
    description: item.description || item.details || item.output || item.longOutput || item.message || `${toolLabels[source] || sourceTool} alert from ${service}.`,
    correlationId: item.correlation_id || item.correlationId || item.traceId || item.problemId || item.problem_id || String(sourceAlertId),
    relatedAlerts: item.related_alerts || item.relatedAlerts || [],
  });
}

function normalizeSourceAlert(sourceTool, item) {
  const normalizedSource = String(sourceTool || '').toLowerCase();

  if (normalizedSource === 'grafana') {
    return normalizeGrafanaAlert(item);
  }

  if (normalizedSource === 'thousandeyes') {
    return normalizeThousandEyesAlert(item);
  }

  return normalizeGenericSourceAlert(normalizedSource, item);
}

async function recordCorrelation(client, alert, duplicateCount) {
  await client.query(
    `
      INSERT INTO alert_correlation_history (
        alert_id,
        duplicate_signature,
        correlation_id,
        duplicate_count,
        related_alerts
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      alert.id,
      alert.duplicate_signature,
      alert.correlation_id,
      duplicateCount,
      JSON.stringify(alert.related_alerts || []),
    ],
  );
}

async function storeIngestedAlert(client, alert, rawAlertId) {
  const insertResult = await client.query(
    `
      INSERT INTO alerts (
        id,
        title,
        service,
        environment,
        severity,
        status,
        classification,
        noise_type,
        confidence_score,
        source,
        source_type,
        source_alert_id,
        source_url,
        raw_payload,
        extracted_details,
        noise_reason,
        classification_reason,
        duplicate_signature,
        correlation_id,
        received_at,
        last_seen_at,
        occurrences,
        responders,
        owner,
        signal,
        description,
        jira_ticket_id,
        recurring_incident,
        related_alerts
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        'unclassified',
        'none',
        NULL,
        $7,
        $8,
        $9,
        $10,
        $11::jsonb,
        $12::jsonb,
        NULL,
        NULL,
        $13,
        $14,
        $15,
        $16,
        1,
        $17::jsonb,
        $18,
        $19,
        $20,
        NULL,
        false,
        $21::jsonb
      )
      ON CONFLICT (id)
      DO UPDATE SET
        title = EXCLUDED.title,
        service = EXCLUDED.service,
        environment = EXCLUDED.environment,
        severity = EXCLUDED.severity,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        source_type = EXCLUDED.source_type,
        source_alert_id = EXCLUDED.source_alert_id,
        source_url = EXCLUDED.source_url,
        raw_payload = EXCLUDED.raw_payload,
        extracted_details = COALESCE(alerts.extracted_details, '{}'::jsonb) || (EXCLUDED.extracted_details - 'classification'),
        duplicate_signature = EXCLUDED.duplicate_signature,
        correlation_id = EXCLUDED.correlation_id,
        last_seen_at = EXCLUDED.last_seen_at,
        occurrences = alerts.occurrences + 1,
        responders = EXCLUDED.responders,
        owner = EXCLUDED.owner,
        signal = EXCLUDED.signal,
        description = EXCLUDED.description,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `,
    [
      alert.id,
      alert.title,
      alert.service,
      alert.environment,
      alert.severity,
      alert.status,
      alert.source,
      alert.sourceType,
      alert.sourceAlertId,
      alert.sourceUrl || null,
      JSON.stringify(alert.rawPayload || {}),
      JSON.stringify(alert.extractedDetails || {}),
      alert.duplicateSignature,
      alert.correlationId,
      alert.receivedAt,
      alert.lastSeenAt,
      JSON.stringify(alert.responders || []),
      alert.owner,
      alert.signal,
      alert.description,
      JSON.stringify(alert.relatedAlerts || []),
    ],
  );

  await client.query(
    `
      UPDATE raw_alerts
      SET normalized_alert_id = $2,
          processing_status = 'normalized'
      WHERE id = $1
    `,
    [rawAlertId, alert.id],
  );

  const matchingResult = await client.query(
    `
      SELECT *
      FROM alerts
      WHERE duplicate_signature = $1
      ORDER BY last_seen_at DESC
    `,
    [alert.duplicateSignature],
  );
  const relatedAlerts = matchingResult.rows
    .map((row) => row.id)
    .filter((id) => id !== alert.id)
    .slice(0, 20);
  const storedResult = await client.query(
    `
      UPDATE alerts
      SET
        related_alerts = $2::jsonb,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      alert.id,
      JSON.stringify(relatedAlerts),
    ],
  );

  await recordCorrelation(client, storedResult.rows[0], matchingResult.rows.length);

  return insertResult.rows[0]?.inserted ? 'inserted' : 'updated';
}

async function ingestGrafana() {
  const config = await integrationService.getIntegrationRuntimeConfig('grafana');
  const url = buildUrl(config.baseUrl, '/api/alertmanager/grafana/api/v2/alerts');

  if (!url) {
    const error = new Error('Grafana URL is missing.');
    error.status = 400;
    throw error;
  }

  const response = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${config.credentials.token}`,
    },
  });

  if (!response.ok) {
    const error = new Error(
      response.status === 401 || response.status === 403
        ? 'Grafana rejected the token while ingesting alerts.'
        : `Grafana alert ingestion returned HTTP ${response.status}.`,
    );
    error.status = 502;
    throw error;
  }

  const items = getGrafanaItems(response.payload);

  return persistIngestedAlerts('grafana', items, normalizeGrafanaAlert);
}

async function ingestThousandEyes() {
  const result = await thousandEyesService.syncThousandEyesData();

  return {
    tool: 'thousandeyes',
    label: 'ThousandEyes',
    fetched: result.fetched,
    rawStored: result.fetched,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    alertIds: [],
    pagesFetched: result.pagesFetched,
    responseTimeMs: result.responseTimeMs,
    durationMs: result.durationMs,
    message: result.message,
  };
}

function buildGenericAuthHeaders(credentials = {}) {
  const headers = {};

  if (credentials.token) {
    headers.Authorization = `Bearer ${credentials.token}`;
  }

  if (credentials.apiKey) {
    headers.Authorization = headers.Authorization || `Bearer ${credentials.apiKey}`;
    headers['X-API-Key'] = credentials.apiKey;
  }

  if (credentials.username && credentials.password) {
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }

  return headers;
}

function getNextPageUrl(payload, currentUrl) {
  const nextValue =
    payload?.next ||
    payload?.nextPage ||
    payload?.next_page ||
    payload?.links?.next ||
    payload?.paging?.next ||
    payload?.pagination?.next;

  if (!nextValue) {
    return null;
  }

  try {
    return new URL(nextValue, currentUrl).toString();
  } catch {
    return null;
  }
}

async function fetchPaginatedItems(startUrl, options = {}) {
  const items = [];
  const startedAt = Date.now();
  let url = startUrl;
  let pages = 0;
  let responseTimeMs = null;
  let lastPayload = null;

  while (url && pages < 100) {
    const requestStartedAt = Date.now();
    const response = await fetchJson(url, options);
    responseTimeMs = Date.now() - requestStartedAt;

    if (!response.ok) {
      const error = new Error(`Monitoring adapter returned HTTP ${response.status}.`);
      error.status = 502;
      throw error;
    }

    lastPayload = response.payload;
    items.push(...getPayloadItems(response.payload).filter(Boolean));
    pages += 1;
    url = getNextPageUrl(response.payload, url);
  }

  return {
    items,
    pages,
    responseTimeMs,
    durationMs: Date.now() - startedAt,
    cursor: lastPayload?.cursor || lastPayload?.nextCursor || lastPayload?.next_cursor || null,
  };
}

async function ingestGenericMonitoringSource(definition, mode = 'incremental') {
  const config = await integrationService.getIntegrationRuntimeConfig(definition.integrationTool || definition.id);
  const url = normalizeBaseUrl(config.baseUrl);

  if (!url) {
    const error = new Error(`${definition.label} alert API URL is missing. Configure the source endpoint first.`);
    error.status = 400;
    throw error;
  }

  const result = await fetchPaginatedItems(url, {
    headers: buildGenericAuthHeaders(config.credentials),
  });
  const summary = await persistIngestedAlerts(
    definition.id,
    result.items,
    (item) => normalizeSourceAlert(definition.id, item),
  );

  return {
    ...summary,
    mode,
    pagesFetched: result.pages,
    responseTimeMs: result.responseTimeMs,
    durationMs: result.durationMs,
    cursor: result.cursor,
  };
}

async function updateSourceStatus(sourceKey, values) {
  const definition = getMonitoringSourceDefinition(sourceKey);

  if (!definition) {
    return;
  }

  await ensureSourceStorage();
  await db.query(
    `
      INSERT INTO monitoring_source_status (
        source_key,
        adapter_name,
        connection_status,
        api_health,
        sync_status,
        last_successful_sync,
        last_failed_sync,
        last_alert_received_at,
        total_alerts_imported,
        last_sync_duration_ms,
        response_time_ms,
        last_error,
        sync_cursor,
        metadata,
        updated_at
      )
      VALUES (
        $1,
        $2,
        COALESCE($3, 'not_configured'),
        COALESCE($4, 'not_configured'),
        COALESCE($5, 'idle'),
        $6,
        $7,
        $8,
        COALESCE($9, 0),
        $10,
        $11,
        $12,
        $13,
        $14::jsonb,
        NOW()
      )
      ON CONFLICT (source_key)
      DO UPDATE SET
        adapter_name = EXCLUDED.adapter_name,
        connection_status = COALESCE($3, monitoring_source_status.connection_status),
        api_health = COALESCE($4, monitoring_source_status.api_health),
        sync_status = COALESCE($5, monitoring_source_status.sync_status),
        last_successful_sync = COALESCE($6, monitoring_source_status.last_successful_sync),
        last_failed_sync = COALESCE($7, monitoring_source_status.last_failed_sync),
        last_alert_received_at = COALESCE($8, monitoring_source_status.last_alert_received_at),
        total_alerts_imported = CASE
          WHEN $9 IS NULL THEN monitoring_source_status.total_alerts_imported
          ELSE monitoring_source_status.total_alerts_imported + $9
        END,
        last_sync_duration_ms = COALESCE($10, monitoring_source_status.last_sync_duration_ms),
        response_time_ms = COALESCE($11, monitoring_source_status.response_time_ms),
        last_error = $12,
        sync_cursor = COALESCE($13, monitoring_source_status.sync_cursor),
        metadata = monitoring_source_status.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      definition.id,
      definition.adapterName,
      values.connectionStatus || null,
      values.apiHealth || null,
      values.syncStatus || null,
      values.lastSuccessfulSync || null,
      values.lastFailedSync || null,
      values.lastAlertReceivedAt || null,
      Number.isFinite(values.totalAlertsImported) ? values.totalAlertsImported : null,
      Number.isFinite(values.lastSyncDurationMs) ? values.lastSyncDurationMs : null,
      Number.isFinite(values.responseTimeMs) ? values.responseTimeMs : null,
      values.lastError || null,
      values.syncCursor || null,
      JSON.stringify(values.metadata || {}),
    ],
  );
}

async function runSourceSync(sourceKey, mode = 'incremental') {
  const definition = getMonitoringSourceDefinition(sourceKey);

  if (!definition) {
    const error = new Error(`Unsupported monitoring source: ${sourceKey}`);
    error.status = 400;
    throw error;
  }

  const startedAt = Date.now();
  await updateSourceStatus(definition.id, {
    connectionStatus: 'checking',
    apiHealth: 'checking',
    syncStatus: mode === 'historical_backfill' ? 'backfilling' : 'syncing',
    metadata: { mode },
  });

  try {
    let result;

    if (isNagiosSource(definition.id)) {
      result = normalizeNagiosPollResult(
        await nagiosService.pollInstance(nagiosInstanceBySource[definition.id]),
        definition,
        mode,
      );
      return {
        ...result,
        sourceKey: definition.id,
        label: definition.label,
        mode,
        durationMs: result.durationMs || Date.now() - startedAt,
      };
    } else if (definition.id === 'grafana') {
      result = await ingestGrafana();
    } else if (definition.id === 'thousandeyes') {
      result = await ingestThousandEyes();
    } else if (definition.id === 'payment-gateway') {
      result = await paymentGatewayService.syncPaymentGatewayData();
    } else if (definition.id === 'abc-hub') {
      result = await abcHubService.syncAbcHubData({ moduleKey: 'daemon-monitor' });
    } else if (definition.id === 'appdynamics') {
      result = await appDynamicsService.syncAppDynamicsData();
    } else {
      result = await ingestGenericMonitoringSource(definition, mode);
    }

    const durationMs = result.durationMs || Date.now() - startedAt;
    const now = new Date().toISOString();

    await updateSourceStatus(definition.id, {
      connectionStatus: 'connected',
      apiHealth: 'connected',
      syncStatus: 'idle',
      lastSuccessfulSync: now,
      lastAlertReceivedAt: result.alertIds?.length ? now : null,
      totalAlertsImported: (result.inserted || 0) + (result.updated || 0),
      lastSyncDurationMs: durationMs,
      responseTimeMs: result.responseTimeMs || null,
      lastError: null,
      syncCursor: result.cursor || null,
      metadata: {
        mode,
        fetched: result.fetched,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        rawStored: result.rawStored,
      },
    });

    return {
      ...result,
      sourceKey: definition.id,
      label: definition.label,
      mode,
      durationMs,
    };
  } catch (error) {
    await updateSourceStatus(definition.id, {
      connectionStatus: error.status === 404 || error.status === 400 ? 'not_configured' : 'disconnected',
      apiHealth: 'disconnected',
      syncStatus: 'failed',
      lastFailedSync: new Date().toISOString(),
      lastSyncDurationMs: Date.now() - startedAt,
      lastError: error.message,
      metadata: { mode },
    });
    throw error;
  }
}

async function persistIngestedAlerts(toolName, rawItems, normalizer = (item) => normalizeSourceAlert(toolName, item)) {
  const client = await db.pool.connect();
  const summary = {
    tool: toolName,
    label: toolLabels[toolName] || toolName,
    fetched: rawItems.length,
    rawStored: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    alertIds: [],
  };

  try {
    await client.query('BEGIN');
    await ensureSourceStorage(client);

    for (const item of rawItems) {
      const rawResult = await client.query(
        `
          INSERT INTO raw_alerts (
            source_tool,
            source_type,
            source_alert_id,
            raw_payload,
            processing_status
          )
          VALUES ($1, 'monitoring', $2, $3::jsonb, 'stored')
          RETURNING id
        `,
        [
          toolName,
          item.id || item.alertId || item.alert_id || item.eventId || item.event_id || null,
          JSON.stringify(item || {}),
        ],
      );
      summary.rawStored += 1;

      let alert;
      try {
        alert = normalizer(item);
      } catch (error) {
        summary.skipped += 1;
        await client.query(
          `
            UPDATE raw_alerts
            SET processing_status = 'normalization_failed',
                error_message = $2
            WHERE id = $1
          `,
          [rawResult.rows[0].id, error.message],
        );
        continue;
      }

      const outcome = await storeIngestedAlert(client, alert, rawResult.rows[0].id);

      if (outcome === 'inserted') {
        summary.inserted += 1;
      } else {
        summary.updated += 1;
      }

      summary.alertIds.push(alert.id);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    ...summary,
    message:
      rawItems.length === 0
        ? `${summary.label} returned no active alerts.`
        : `${summary.label} ingestion complete: ${summary.rawStored} raw stored, ${summary.inserted} new, ${summary.updated} updated, ${summary.skipped} normalization issue(s).`,
  };
}

function getPayloadItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.alerts)) {
    return payload.alerts;
  }

  if (Array.isArray(payload?.events)) {
    return payload.events;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [payload];
}

async function ingestSourcePayload(sourceTool, payload) {
  const definition = getMonitoringSourceDefinition(sourceTool);
  const sourceKey = definition?.id || String(sourceTool || 'unknown-source').toLowerCase();
  const startedAt = Date.now();
  const items = getPayloadItems(payload).filter(Boolean);
  const result = await persistIngestedAlerts(
    sourceKey,
    items,
    (item) => normalizeSourceAlert(sourceKey, item),
  );

  if (definition) {
    await updateSourceStatus(definition.id, {
      connectionStatus: 'connected',
      apiHealth: 'connected',
      syncStatus: 'idle',
      lastSuccessfulSync: new Date().toISOString(),
      lastAlertReceivedAt: items.length > 0 ? new Date().toISOString() : null,
      totalAlertsImported: (result.inserted || 0) + (result.updated || 0),
      lastSyncDurationMs: Date.now() - startedAt,
      lastError: null,
      metadata: {
        mode: 'direct_payload',
        fetched: result.fetched,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
      },
    });
  }

  return result;
}

async function ingestTool(toolName) {
  try {
    return await runSourceSync(toolName, 'incremental');
  } catch (error) {
    if (error.code === '42703') {
      error.message = 'Database schema is missing an alert column required for ingestion. Run the monitoring ingestion migration, then retry.';
      error.status = 500;
    } else if (!error.status && String(toolName).toLowerCase() === 'grafana') {
      error.message = getNetworkMessage('Grafana', error);
      error.status = 502;
    }
    throw error;
  }
}

async function runBackfill(sourceKey) {
  return runSourceSync(sourceKey, 'historical_backfill');
}

function mapSourceStatusRow(row) {
  if (!row) {
    return {};
  }

  return {
    connectionStatus: row.connection_status,
    apiHealth: row.api_health,
    syncStatus: row.sync_status,
    lastSuccessfulSync: row.last_successful_sync,
    lastFailedSync: row.last_failed_sync,
    lastAlertReceivedAt: row.last_alert_received_at,
    totalAlertsImported: Number(row.total_alerts_imported || 0),
    lastSyncDurationMs: row.last_sync_duration_ms,
    responseTimeMs: row.response_time_ms,
    lastError: row.last_error,
    syncCursor: row.sync_cursor,
    metadata: row.metadata || {},
  };
}

async function getMonitoringSources() {
  await ensureSourceStorage();

  const [statusResult, integrationRowsResult, alertResult] = await Promise.all([
    db.query('SELECT * FROM monitoring_source_status'),
    db.query('SELECT tool_name, base_url, account_identifier, is_enabled, status, last_tested_at FROM integrations'),
    db.query(`
      SELECT
        id,
        source,
        source_type,
        source_alert_id,
        extracted_details->'normalized_alert'->>'source_tool' AS source_tool,
        extracted_details->'normalized_alert'->>'source_name' AS source_name,
        extracted_details->'normalized_alert'->>'source_instance' AS source_instance,
        extracted_details->'normalized_alert'->>'application' AS application,
        extracted_details->'jira'->>'monitoring_system_name' AS monitoring_system_name,
        extracted_details->'custom_properties'->>'source_tool' AS custom_source_tool,
        extracted_details->'custom_properties'->>'source_instance' AS custom_source_instance,
        received_at,
        last_seen_at,
        created_at
      FROM alerts
    `),
  ]);
  const statusesBySource = Object.fromEntries(statusResult.rows.map((row) => [row.source_key, row]));
  const integrationsByTool = Object.fromEntries(integrationRowsResult.rows.map((row) => [row.tool_name, row]));

  return {
    sources: monitoringSourceDefinitions.map((definition) => {
      const sourceAlerts = alertResult.rows.filter((alert) => sourceMatchesDefinition(alert, definition));
      const storedLastAlert = sourceAlerts
        .map((alert) => new Date(alert.last_seen_at || alert.received_at || alert.created_at).getTime())
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => b - a)[0];
      const status = mapSourceStatusRow(statusesBySource[definition.id]);
      const integration = integrationsByTool[definition.integrationTool];
      const connectionStatus = integration
        ? status.connectionStatus === 'not_configured' ? (integration.status === 'connected' ? 'connected' : 'disconnected') : status.connectionStatus
        : status.connectionStatus || 'not_configured';

      return {
        ...definition,
        configured: Boolean(integration),
        enabled: Boolean(integration?.is_enabled),
        integrationStatus: integration?.status || 'not_configured',
        connectionStatus,
        apiHealth: status.apiHealth || connectionStatus,
        syncStatus: status.syncStatus || 'idle',
        lastSuccessfulSync: status.lastSuccessfulSync || null,
        lastFailedSync: status.lastFailedSync || null,
        lastAlertReceivedAt: status.lastAlertReceivedAt || (storedLastAlert ? new Date(storedLastAlert).toISOString() : null),
        totalAlertsImported: Math.max(status.totalAlertsImported || 0, sourceAlerts.length),
        lastSyncDurationMs: status.lastSyncDurationMs || null,
        responseTimeMs: status.responseTimeMs || null,
        lastError: status.lastError || null,
        syncCursor: status.syncCursor || null,
      };
    }),
  };
}

module.exports = {
  finalizeNormalizedAlert,
  getMonitoringSources,
  runBackfill,
  ingestSourcePayload,
  ingestTool,
};
