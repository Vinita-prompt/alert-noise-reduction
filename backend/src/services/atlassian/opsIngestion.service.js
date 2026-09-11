const crypto = require('crypto');
const db = require('../../config/db');
const alertService = require('../alert.service');
const { service: liveOccurrenceAutomationService } = require('../liveOccurrenceAutomation.service');
const {
  notEvaluatedMetadata,
  unclassifiedFoundationState,
} = require('../../config/decisionLayer');
const {
  getClientStatusesAsync,
  getConfig: getAtlassianClientConfig,
  getConfigAsync: getAtlassianClientConfigAsync,
  jiraReadClient,
  opsReadClient,
  opsWriteClient,
  jsmReadClient,
  sanitizeError: sanitizeAtlassianError,
} = require('./clients');

const OPS_SOURCE = 'jsm_ops';
const SYNC_NAME = 'atlassian_jsm_ops_alerts';
const DEFAULT_PAGE_SIZE = 100;
const MAX_RETRIEVABLE_ALERTS_PER_WINDOW = 20000;
const ACKNOWLEDGE_POLLING_DEFAULTS = Object.freeze({
  initialDelayMs: 250,
  maxDelayMs: 2000,
  maxDurationMs: 15000,
});
const ACKNOWLEDGEMENT_LOG_CLOCK_TOLERANCE_MS = 5000;

let storageEnsured = false;
let pollTimer = null;
let pollingStarted = false;
let syncInProgress = false;

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildConfigFromAtlassianConfig(atlassianConfig) {
  const cloudId = atlassianConfig.cloudId;
  const siteUrl = stripTrailingSlash(atlassianConfig.siteUrl || '');
  const email = atlassianConfig.email;
  const opsReadToken = atlassianConfig.tokens.operationsRead;
  const jiraReadToken = atlassianConfig.tokens.jiraRead;
  const pollIntervalSeconds = Math.max(Number(atlassianConfig.opsPollIntervalSeconds || 30), 5);
  const initialSyncDays = Math.max(Number(atlassianConfig.initialSyncDays || 30), 1);
  const pollingEnabled = Boolean(atlassianConfig.opsPollingEnabled);

  return {
    cloudId,
    email,
    initialSyncDays,
    jiraBaseUrl: atlassianConfig.jiraGatewayBaseUrl,
    jiraReadToken,
    opsBaseUrl: atlassianConfig.opsGatewayBaseUrl,
    opsReadToken,
    pollIntervalSeconds,
    pollingEnabled,
    siteUrl,
  };
}

function getConfig() {
  return buildConfigFromAtlassianConfig(getAtlassianClientConfig());
}

async function getEffectiveConfig() {
  return buildConfigFromAtlassianConfig(await getAtlassianClientConfigAsync());
}

function getMissingConfig(config = getConfig()) {
  return [
    ['ATLASSIAN_EMAIL', config.email],
    ['ATLASSIAN_CLOUD_ID', config.cloudId],
    ['ATLASSIAN_OPS_READ_TOKEN', config.opsReadToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

function assertOpsConfig(config = getConfig()) {
  const missing = getMissingConfig(config);

  if (missing.length > 0) {
    const error = new Error(`Atlassian Operations configuration is missing: ${missing.join(', ')}.`);
    error.status = 400;
    error.code = 'missing_configuration';
    throw error;
  }
}

function sanitizeError(error) {
  return sanitizeAtlassianError(error);
}

async function opsRequest(path, query = {}, options = {}) {
  return opsReadClient.request(path, { ...options, query });
}

async function jiraRequest(path, query = {}, options = {}) {
  return jiraReadClient.request(path, { ...options, query });
}

async function ensureStorage() {
  if (storageEnsured) {
    return;
  }

  await alertService.ensureAlertOptionalColumns();
  await db.query(`
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_alert_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_tiny_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_alias TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_last_synced_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_jsm_ops_external_id
      ON alerts(source_alert_id)
      WHERE source = 'jsm_ops' AND source_alert_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS alert_activity_logs (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      external_log_id TEXT,
      event_type TEXT NOT NULL DEFAULT 'activity',
      actor TEXT,
      message TEXT,
      activity_at TIMESTAMPTZ,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (alert_id, external_log_id)
    );

    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS external_note_id TEXT;
    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';
    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_notes_external_note_id
      ON alert_notes(alert_id, external_note_id)
      WHERE external_note_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS alert_responders (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      responder_external_id TEXT,
      responder_type TEXT,
      responder_name TEXT,
      role TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (alert_id, responder_external_id, responder_type)
    );

    CREATE TABLE IF NOT EXISTS alert_attachments (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      external_attachment_id TEXT,
      file_name TEXT,
      content_type TEXT,
      size_bytes BIGINT,
      source_url TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (alert_id, external_attachment_id)
    );

    CREATE TABLE IF NOT EXISTS atlassian_sync_state (
      sync_name TEXT PRIMARY KEY,
      checkpoint TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      last_successful_sync_at TIMESTAMPTZ,
      last_result TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      alerts_imported INTEGER NOT NULL DEFAULT 0,
      alerts_updated INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS integration_sync_runs (
      id BIGSERIAL PRIMARY KEY,
      integration_name TEXT NOT NULL,
      sync_type TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      fetched INTEGER NOT NULL DEFAULT 0,
      inserted INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      unchanged INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_alert_activity_logs_alert_time ON alert_activity_logs(alert_id, activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_responders_alert_id ON alert_responders(alert_id);
    CREATE INDEX IF NOT EXISTS idx_alert_attachments_alert_id ON alert_attachments(alert_id);
    CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_atlassian ON integration_sync_runs(integration_name, started_at DESC);
  `);
  storageEnsured = true;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getDisplayName(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;

  return firstValue(
    value.displayName,
    value.fullName,
    value.name,
    value.username,
    value.email,
    value.accountId,
    value.id,
  );
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEnvironment(alert) {
  const text = [
    alert.environment,
    alert.env,
    alert.message,
    alert.description,
    ...asArray(alert.tags),
    JSON.stringify(alert.extraProperties || alert.extra_properties || {}),
  ].join(' ').toLowerCase();

  if (/\bprod(uction)?\b/.test(text)) return 'production';
  if (/\bstag(e|ing)?\b/.test(text)) return 'staging';
  if (/\bdev(elopment)?\b/.test(text)) return 'development';
  return 'unknown';
}

function normalizeSeverity(alert) {
  const priority = String(firstValue(alert.priority, alert.priorityName, alert.severity, '')).toLowerCase();
  const text = [priority, alert.message, alert.description].join(' ').toLowerCase();

  if (/\bp1\b|critical|severe/.test(text)) return 'critical';
  if (/\bp2\b|high|major/.test(text)) return 'high';
  if (/\bp3\b|medium|warning|warn/.test(text)) return 'medium';
  if (/\bp4\b|\blow\b|minor|info/.test(text)) return 'low';
  return 'medium';
}

function normalizeStatus(alert) {
  const status = String(firstValue(alert.status, alert.state, '')).toLowerCase();
  const acknowledged = Boolean(firstValue(alert.acknowledged, alert.isAcknowledged));
  const closedAt = firstValue(alert.closedAt, alert.closed_at, alert.closeTime, alert.endTime);

  if (closedAt || /closed|resolved|recovered/.test(status)) return 'closed';
  if (/snooz/.test(status)) return 'investigating';
  if (acknowledged || /ack/.test(status)) return 'acknowledged';
  if (/triggered/.test(status)) return 'triggered';
  if (/firing|open|active/.test(status)) return 'open';
  return 'open';
}

function getAlertExternalId(alert) {
  return String(firstValue(
    alert.id,
    alert.alertId,
    alert.alert_id,
    alert.tinyId,
    alert.tiny_id,
    alert.alias,
  ) || crypto.createHash('sha1').update(JSON.stringify(alert)).digest('hex'));
}

function getLocalAlertId(externalId) {
  const sanitized = String(externalId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 42);

  if (sanitized) {
    return `JSMOPS-${sanitized}`;
  }

  return `JSMOPS-${crypto.randomUUID()}`;
}

function findJiraKeys(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  const matches = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || [];

  return [...new Set(matches)];
}

function findUrls(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  const matches = text.match(/https?:\/\/[^\s"<>]+/g) || [];

  return [...new Set(matches.map((url) => url.replace(/[),.]+$/, '')))];
}

function pickMonitoringDeepLink(alert, urls) {
  const direct = firstValue(
    alert.deepLink,
    alert.deep_link,
    alert.eventLink,
    alert.event_link,
    alert.url,
    alert.sourceUrl,
    alert.source_url,
    alert.detailsUrl,
    alert.details_url,
    alert.extraProperties?.event_deep_link,
    alert.extraProperties?.eventDeepLink,
    alert.extraProperties?.controller_url,
    alert.extra_properties?.event_deep_link,
    alert.extra_properties?.controller_url,
  );

  if (direct) return direct;

  return urls.find((url) => !/atlassian\.net|jira/i.test(url)) || urls[0] || null;
}

function detectMonitoringTool(alert, urls) {
  const text = [
    alert.source,
    alert.sourceName,
    alert.source_name,
    alert.integrationName,
    alert.integration?.name,
    alert.message,
    alert.description,
    ...urls,
  ].join(' ').toLowerCase();

  if (text.includes('grafana')) return 'Grafana';
  if (text.includes('appd') || text.includes('appdynamic')) return 'AppDynamics';
  if (text.includes('thousandeyes') || text.includes('thousand eyes')) return 'ThousandEyes';
  if (text.includes('nagios')) return 'Nagios';
  if (text.includes('splunk')) return 'Splunk';
  if (text.includes('payment')) return 'Payment Gateway';
  if (text.includes('abc hub') || text.includes('abchub')) return 'ABC Hub';

  return getDisplayName(alert.integration) || firstValue(alert.source, alert.sourceName, alert.source_name, 'JSM Operations');
}

function adfToText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(adfToText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);

  const parts = [];

  if (value.text) parts.push(value.text);
  if (Array.isArray(value.content)) {
    parts.push(value.content.map(adfToText).filter(Boolean).join(value.type === 'paragraph' ? ' ' : '\n'));
  }

  return parts.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim() || null;
}

function normalizeJiraIssue(issue, commentsPayload, changelogPayload, fieldMap = {}) {
  if (!issue?.key) {
    return null;
  }

  const fields = issue.fields || {};
  const customFields = Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => key.startsWith('customfield_'))
      .map(([key, value]) => [
        key,
        {
          id: key,
          name: fieldMap[key] || key,
          raw: value,
          text: adfToText(value) || (typeof value === 'object' ? null : value),
        },
      ]),
  );

  const comments = asArray(commentsPayload?.comments || commentsPayload?.values).map((comment) => ({
    id: comment.id,
    author: comment.author,
    body: adfToText(comment.body),
    created: comment.created,
    updated: comment.updated,
    raw_payload: comment,
  }));

  const histories = asArray(changelogPayload?.values || changelogPayload?.histories).map((history) => ({
    id: history.id,
    author: history.author,
    created: history.created,
    items: asArray(history.items).map((item) => ({
      field: item.field,
      from: firstValue(item.fromString, item.from),
      to: firstValue(item.toString, item.to),
    })),
    raw_payload: history,
  }));

  return {
    issue_key: issue.key,
    issue_id: issue.id,
    issue_url: getConfig().siteUrl ? `${getConfig().siteUrl}/browse/${issue.key}` : null,
    summary: fields.summary || null,
    description: adfToText(fields.description),
    status: fields.status?.name || null,
    status_category: fields.status?.statusCategory?.name || null,
    priority: fields.priority?.name || null,
    assignee: fields.assignee || null,
    reporter: fields.reporter || null,
    labels: fields.labels || [],
    components: fields.components || [],
    issue_type: fields.issuetype?.name || null,
    project: fields.project || null,
    created: fields.created || null,
    updated: fields.updated || null,
    resolution: fields.resolution?.name || null,
    resolution_date: fields.resolutiondate || null,
    comments,
    changelog: histories,
    custom_fields: customFields,
    raw_issue_payload: issue,
    raw_comments_payload: commentsPayload,
    raw_changelog_payload: changelogPayload,
  };
}

let fieldMapCache = {
  expiresAt: 0,
  value: {},
};

async function getJiraFieldMap() {
  const now = Date.now();

  if (fieldMapCache.expiresAt > now) {
    return fieldMapCache.value;
  }

  const response = await jiraRequest('/rest/api/3/field');
  const fieldMap = Object.fromEntries(asArray(response.body).map((field) => [field.id, field.name]));

  fieldMapCache = {
    expiresAt: now + 10 * 60 * 1000,
    value: fieldMap,
  };

  return fieldMap;
}

async function enrichJira(issueKey) {
  if (!issueKey) {
    return { jira: null, error: null };
  }

  try {
    const fieldMap = await getJiraFieldMap();
    const [issueResponse, commentsResponse, changelogResponse] = await Promise.all([
      jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        fields: '*all',
      }),
      jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        maxResults: 100,
      }),
      jiraRequest(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`, {
        maxResults: 100,
      }),
    ]);

    return {
      error: null,
      jira: normalizeJiraIssue(issueResponse.body, commentsResponse.body, changelogResponse.body, fieldMap),
    };
  } catch (error) {
    return {
      error: sanitizeError(error),
      jira: null,
    };
  }
}

function normalizeAlert(alert, childData = {}, jiraEnrichment = {}) {
  const externalId = getAlertExternalId(alert);
  const tinyId = firstValue(alert.tinyId, alert.tiny_id, alert.displayId, alert.number);
  const alias = firstValue(alert.alias, alert.deduplicationAlias, alert.alertAlias);
  const urls = findUrls(alert);
  const jiraKeys = findJiraKeys(alert);
  const jiraIssueKey = jiraEnrichment.jira?.issue_key || jiraKeys[0] || null;
  const monitoringEventUrl = pickMonitoringDeepLink(alert, urls);
  const createdAt = parseDate(firstValue(alert.createdAt, alert.created_at, alert.createTime, alert.firstSeenAt, alert.firstSeen, alert.startedAt)) || new Date().toISOString();
  const updatedAt = parseDate(firstValue(alert.updatedAt, alert.updated_at, alert.updateTime, alert.lastSeenAt, alert.lastOccurredAt, alert.lastOccuredAt)) || createdAt;
  const closedAt = parseDate(firstValue(alert.closedAt, alert.closed_at, alert.closeTime, alert.endTime));
  const acknowledged = Boolean(firstValue(alert.acknowledged, alert.isAcknowledged, alert.acknowledgedAt, alert.ackTime));
  const acknowledgedAt = parseDate(firstValue(alert.acknowledgedAt, alert.ackTime, alert.acknowledgeTime));
  const owner = getDisplayName(firstValue(alert.owner, alert.assignee, alert.acknowledgedBy, alert.acknowledged_by)) || 'Unassigned';
  const responders = asArray(firstValue(alert.responders, childData.responders)).map((responder) => ({
    id: firstValue(responder.id, responder.accountId, responder.teamId, responder.name),
    name: getDisplayName(responder),
    type: firstValue(responder.type, responder.responderType, responder.teamId ? 'team' : 'user'),
    role: responder.role || 'responder',
    raw: responder,
  }));
  const status = normalizeStatus({ ...alert, acknowledged, closedAt });
  const severity = normalizeSeverity(alert);
  const priority = firstValue(alert.priority, alert.priorityName, severity);
  const service = firstValue(
    alert.service,
    alert.application,
    alert.entity,
    alert.extraProperties?.service,
    alert.extraProperties?.application,
    alert.extra_properties?.service,
    'unknown-service',
  );
  const environment = normalizeEnvironment(alert);
  const title = firstValue(alert.message, alert.title, alert.summary, alert.name, `JSM Operations alert ${tinyId || externalId}`);
  const description = firstValue(alert.description, alert.details, alert.longDescription, title);
  const monitoringTool = detectMonitoringTool(alert, urls);
  const occurrenceCount = Math.max(Number(firstValue(alert.count, alert.occurrenceCount, alert.occurrences, alert.repeatCount) || 1), 1);
  const baseRow = {
    id: getLocalAlertId(externalId),
    title: String(title).slice(0, 1000),
    service: String(service || 'unknown-service').slice(0, 255),
    environment,
    severity,
    status,
    source: OPS_SOURCE,
    source_type: 'monitoring',
    source_alert_id: externalId,
    source_url: getConfig().siteUrl ? `${getConfig().siteUrl}/jira/ops/alerts/${externalId}` : monitoringEventUrl,
    signal: String(title).slice(0, 1000),
    description: String(description).slice(0, 4000),
    owner,
    occurrences: occurrenceCount,
    received_at: createdAt,
    last_seen_at: updatedAt,
    jira_ticket_id: jiraIssueKey,
    acknowledged,
    acknowledged_by: acknowledged ? owner : null,
    acknowledged_at: acknowledgedAt,
    acknowledgement_source: acknowledged ? 'jsm_operations' : null,
    responders,
    atlassian_ops_alert_id: externalId,
    atlassian_ops_tiny_id: tinyId ? String(tinyId) : null,
    atlassian_ops_alias: alias ? String(alias) : null,
  };
  const foundationState = unclassifiedFoundationState();
  const extractedDetails = {
    normalized_alert: {
      source_tool: OPS_SOURCE,
      source_name: 'JSM Operations',
      monitoring_tool: monitoringTool,
      message: title,
      entity: firstValue(alert.entity, alert.node, alert.host, service),
      application: firstValue(
        alert.application,
        alert.extraProperties?.application,
        alert.extra_properties?.application,
      ),
      service,
      environment,
      monitoring_event_url: monitoringEventUrl,
      event_link: monitoringEventUrl,
      deep_event_link: monitoringEventUrl,
      ops_alert_id: externalId,
      tiny_id: tinyId,
      alias,
      priority,
      severity,
      status,
      state: closedAt ? 'closed' : 'open',
      created_at: createdAt,
      updated_at: updatedAt,
      first_seen_at: createdAt,
      last_seen_at: updatedAt,
      closed_at: closedAt,
      snoozed_until: parseDate(firstValue(alert.snoozedUntil, alert.snoozed_until)),
      occurrence_count: occurrenceCount,
      acknowledged,
      acknowledged_at: acknowledgedAt,
      owner,
      responders,
      tags: asArray(alert.tags),
      extra_properties: firstValue(alert.extraProperties, alert.extra_properties, {}),
      jira_issue_key: jiraIssueKey,
      jira_url: jiraEnrichment.jira?.issue_url || (getConfig().siteUrl && jiraIssueKey ? `${getConfig().siteUrl}/browse/${jiraIssueKey}` : null),
      jira_summary: jiraEnrichment.jira?.summary || null,
      jira_status: jiraEnrichment.jira?.status || null,
    },
    jsm_ops: {
      alert_id: externalId,
      alias,
      tiny_id: tinyId,
      links: urls,
      child_fetch: childData.statuses || {},
      raw_child_payloads: childData.raw || {},
    },
    jira: jiraEnrichment.jira,
    jira_enrichment_error: jiraEnrichment.error,
    classification: notEvaluatedMetadata(),
  };

  return {
    ...baseRow,
    classification: foundationState.classification,
    noise_type: foundationState.noiseType,
    confidence_score: foundationState.confidenceScore,
    noise_reason: foundationState.noiseReason,
    classification_reason: foundationState.classificationReason,
    raw_payload: alert,
    extracted_details: extractedDetails,
  };
}

function getValuesFromListResponse(payload) {
  if (Array.isArray(payload?.values)) return payload.values;
  if (Array.isArray(payload?.alerts)) return payload.alerts;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;

  const error = new Error('JSM Operations list response did not contain an alerts array.');
  error.status = 502;
  error.code = 'malformed_ops_response';
  throw error;
}

async function listAlertsPage({ offset, from, to, size = DEFAULT_PAGE_SIZE, sort = 'updatedAt' }) {
  const query = {
    from,
    offset,
    order: 'asc',
    size,
    sort,
    to,
  };

  return opsRequest('/v1/alerts', query);
}

function hasNextAlertsPage({ alerts = [], offset = 0, page = {}, size = DEFAULT_PAGE_SIZE }) {
  if (!alerts.length) return false;
  const nextLink = page?.body?.links?.next || page?.body?.next;
  if (nextLink) return true;
  const count = Number(page?.body?.count || page?.body?.total || 0);
  return alerts.length === size
    && (count === 0 || offset + alerts.length < Math.min(count, MAX_RETRIEVABLE_ALERTS_PER_WINDOW));
}

async function getAlertDetails(alertId) {
  const response = await opsRequest(`/v1/alerts/${encodeURIComponent(alertId)}`);

  return response.body || {};
}

async function getOptionalChild(path, label) {
  try {
    const response = await opsRequest(path, { size: 100 });

    return {
      error: null,
      payload: response.body,
      status: 'ok',
    };
  } catch (error) {
    return {
      error: sanitizeError(error),
      payload: null,
      status: `${label}_unavailable`,
    };
  }
}

async function getChildResources(alertId) {
  const [notes, logs, attachments] = await Promise.all([
    getOptionalChild(`/v1/alerts/${encodeURIComponent(alertId)}/notes`, 'notes'),
    getOptionalChild(`/v1/alerts/${encodeURIComponent(alertId)}/logs`, 'logs'),
    getOptionalChild(`/v1/alerts/${encodeURIComponent(alertId)}/attachments`, 'attachments'),
  ]);

  return {
    raw: {
      attachments: attachments.payload,
      logs: logs.payload,
      notes: notes.payload,
    },
    statuses: {
      attachments: attachments.error || attachments.status,
      logs: logs.error || logs.status,
      notes: notes.error || notes.status,
    },
  };
}

async function upsertAlert(client, normalized) {
  const result = await client.query(
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
        source,
        source_type,
        source_alert_id,
        source_url,
        signal,
        description,
        owner,
        occurrences,
        received_at,
        last_seen_at,
        jira_ticket_id,
        raw_payload,
        extracted_details,
        acknowledged,
        acknowledged_by,
        acknowledged_at,
        acknowledgement_source,
        responders,
        confidence_score,
        noise_reason,
        classification_reason,
        atlassian_ops_alert_id,
        atlassian_ops_tiny_id,
        atlassian_ops_alias,
        atlassian_last_synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        $17::timestamptz, $18::timestamptz, $19,
        $20::jsonb, $21::jsonb, $22, $23, $24::timestamptz,
        $25, $26::jsonb, $27, $28, $29, $30, $31, $32, NOW()
      )
      ON CONFLICT (source_alert_id) WHERE source = 'jsm_ops' AND source_alert_id IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        service = EXCLUDED.service,
        environment = EXCLUDED.environment,
        severity = EXCLUDED.severity,
        status = EXCLUDED.status,
        source_url = EXCLUDED.source_url,
        signal = EXCLUDED.signal,
        description = EXCLUDED.description,
        owner = EXCLUDED.owner,
        occurrences = GREATEST(alerts.occurrences, EXCLUDED.occurrences),
        last_seen_at = GREATEST(alerts.last_seen_at, EXCLUDED.last_seen_at),
        jira_ticket_id = COALESCE(EXCLUDED.jira_ticket_id, alerts.jira_ticket_id),
        raw_payload = EXCLUDED.raw_payload,
        extracted_details = COALESCE(alerts.extracted_details, '{}'::jsonb) || (EXCLUDED.extracted_details - 'classification'),
        acknowledged = EXCLUDED.acknowledged OR alerts.acknowledged,
        acknowledged_by = COALESCE(EXCLUDED.acknowledged_by, alerts.acknowledged_by),
        acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, alerts.acknowledged_at),
        acknowledgement_source = COALESCE(EXCLUDED.acknowledgement_source, alerts.acknowledgement_source),
        responders = EXCLUDED.responders,
        atlassian_ops_alert_id = EXCLUDED.atlassian_ops_alert_id,
        atlassian_ops_tiny_id = EXCLUDED.atlassian_ops_tiny_id,
        atlassian_ops_alias = EXCLUDED.atlassian_ops_alias,
        atlassian_last_synced_at = NOW(),
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `,
    [
      normalized.id,
      normalized.title,
      normalized.service,
      normalized.environment,
      normalized.severity,
      normalized.status,
      normalized.classification,
      normalized.noise_type,
      normalized.source,
      normalized.source_type,
      normalized.source_alert_id,
      normalized.source_url,
      normalized.signal,
      normalized.description,
      normalized.owner,
      normalized.occurrences,
      normalized.received_at,
      normalized.last_seen_at,
      normalized.jira_ticket_id,
      JSON.stringify(normalized.raw_payload || {}),
      JSON.stringify(normalized.extracted_details || {}),
      normalized.acknowledged,
      normalized.acknowledged_by,
      normalized.acknowledged_at,
      normalized.acknowledgement_source,
      JSON.stringify(normalized.responders || []),
      normalized.confidence_score,
      normalized.noise_reason,
      normalized.classification_reason,
      normalized.atlassian_ops_alert_id,
      normalized.atlassian_ops_tiny_id,
      normalized.atlassian_ops_alias,
    ],
  );

  return result.rows[0];
}

function childValues(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.values)) return payload.values;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.notes)) return payload.notes;
  if (Array.isArray(payload.logs)) return payload.logs;
  if (Array.isArray(payload.attachments)) return payload.attachments;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function storeChildResources(client, alertId, childData = {}) {
  const notes = childValues(childData.raw?.notes);
  const logs = childValues(childData.raw?.logs);
  const attachments = childValues(childData.raw?.attachments);

  for (const note of notes) {
    const externalNoteId = firstValue(note.id, note.noteId, note.createdAt, crypto.createHash('sha1').update(JSON.stringify(note)).digest('hex'));
    await client.query(
      `
        INSERT INTO alert_notes (alert_id, note, created_by, created_at, external_note_id, source, raw_payload, updated_at)
        VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, 'jsm_operations', $6::jsonb, $7::timestamptz)
        ON CONFLICT (alert_id, external_note_id) WHERE external_note_id IS NOT NULL
        DO UPDATE SET
          note = EXCLUDED.note,
          created_by = EXCLUDED.created_by,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = COALESCE(EXCLUDED.updated_at, alert_notes.updated_at)
      `,
      [
        alertId,
        firstValue(note.note, note.message, note.text, note.body, 'Operations note'),
        getDisplayName(firstValue(note.author, note.createdBy, note.owner)) || 'JSM Operations',
        parseDate(firstValue(note.createdAt, note.created_at)),
        String(externalNoteId),
        JSON.stringify(note),
        parseDate(firstValue(note.updatedAt, note.updated_at)),
      ],
    );
  }

  for (const log of logs) {
    const externalLogId = firstValue(log.id, log.logId, log.createdAt, crypto.createHash('sha1').update(JSON.stringify(log)).digest('hex'));
    await client.query(
      `
        INSERT INTO alert_activity_logs (alert_id, external_log_id, event_type, actor, message, activity_at, raw_payload)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7::jsonb)
        ON CONFLICT (alert_id, external_log_id)
        DO UPDATE SET
          event_type = EXCLUDED.event_type,
          actor = EXCLUDED.actor,
          message = EXCLUDED.message,
          activity_at = EXCLUDED.activity_at,
          raw_payload = EXCLUDED.raw_payload
      `,
      [
        alertId,
        String(externalLogId),
        firstValue(log.type, log.action, log.eventType, 'activity'),
        getDisplayName(firstValue(log.actor, log.user, log.owner)),
        firstValue(log.message, log.description, log.text, log.action, 'Operations activity'),
        parseDate(firstValue(log.createdAt, log.created_at, log.timestamp, log.time)),
        JSON.stringify(log),
      ],
    );
  }

  for (const attachment of attachments) {
    const externalAttachmentId = firstValue(attachment.id, attachment.attachmentId, attachment.name, crypto.createHash('sha1').update(JSON.stringify(attachment)).digest('hex'));
    await client.query(
      `
        INSERT INTO alert_attachments (
          alert_id,
          external_attachment_id,
          file_name,
          content_type,
          size_bytes,
          source_url,
          raw_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (alert_id, external_attachment_id)
        DO UPDATE SET
          file_name = EXCLUDED.file_name,
          content_type = EXCLUDED.content_type,
          size_bytes = EXCLUDED.size_bytes,
          source_url = EXCLUDED.source_url,
          raw_payload = EXCLUDED.raw_payload
      `,
      [
        alertId,
        String(externalAttachmentId),
        firstValue(attachment.name, attachment.fileName, attachment.filename),
        firstValue(attachment.contentType, attachment.mimeType),
        Number(firstValue(attachment.size, attachment.sizeBytes) || 0),
        firstValue(attachment.url, attachment.downloadUrl, attachment.self),
        JSON.stringify(attachment),
      ],
    );
  }
}

async function storeResponders(client, alertId, responders = []) {
  for (const responder of responders) {
    const externalId = firstValue(responder.id, responder.accountId, responder.teamId, responder.name);

    if (!externalId) {
      continue;
    }

    await client.query(
      `
        INSERT INTO alert_responders (
          alert_id,
          responder_external_id,
          responder_type,
          responder_name,
          role,
          raw_payload,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
        ON CONFLICT (alert_id, responder_external_id, responder_type)
        DO UPDATE SET
          responder_name = EXCLUDED.responder_name,
          role = EXCLUDED.role,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        alertId,
        String(externalId),
        String(responder.type || 'user'),
        responder.name || String(externalId),
        responder.role || 'responder',
        JSON.stringify(responder.raw || responder),
      ],
    );
  }
}

async function createSyncRun(syncType, metadata = {}) {
  const result = await db.query(
    `
      INSERT INTO integration_sync_runs (integration_name, sync_type, status, metadata)
      VALUES ('atlassian-jsm-operations', $1, 'running', $2::jsonb)
      RETURNING id, started_at
    `,
    [syncType, JSON.stringify(metadata)],
  );

  return result.rows[0];
}

async function finishSyncRun(id, status, counts, error = null) {
  await db.query(
    `
      UPDATE integration_sync_runs
      SET
        status = $2,
        completed_at = NOW(),
        fetched = $3,
        inserted = $4,
        updated = $5,
        unchanged = $6,
        failed = $7,
        error_code = $8,
        error_message = $9
      WHERE id = $1
    `,
    [
      id,
      status,
      counts.fetched || 0,
      counts.inserted || 0,
      counts.updated || 0,
      counts.unchanged || 0,
      counts.failed || 0,
      error?.code || null,
      error?.message || null,
    ],
  );
}

async function getState() {
  await ensureStorage();
  const result = await db.query('SELECT * FROM atlassian_sync_state WHERE sync_name = $1', [SYNC_NAME]);

  return result.rows[0] || null;
}

async function updateStatePatch(patch = {}) {
  const metadata = patch.metadata || {};

  await db.query(
    `
      INSERT INTO atlassian_sync_state (
        sync_name,
        checkpoint,
        last_attempt_at,
        last_successful_sync_at,
        last_result,
        last_error_code,
        last_error_message,
        alerts_imported,
        alerts_updated,
        metadata,
        updated_at
      )
      VALUES ($1, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb, NOW())
      ON CONFLICT (sync_name)
      DO UPDATE SET
        checkpoint = COALESCE(EXCLUDED.checkpoint, atlassian_sync_state.checkpoint),
        last_attempt_at = COALESCE(EXCLUDED.last_attempt_at, atlassian_sync_state.last_attempt_at),
        last_successful_sync_at = COALESCE(EXCLUDED.last_successful_sync_at, atlassian_sync_state.last_successful_sync_at),
        last_result = COALESCE(EXCLUDED.last_result, atlassian_sync_state.last_result),
        last_error_code = EXCLUDED.last_error_code,
        last_error_message = EXCLUDED.last_error_message,
        alerts_imported = atlassian_sync_state.alerts_imported + EXCLUDED.alerts_imported,
        alerts_updated = atlassian_sync_state.alerts_updated + EXCLUDED.alerts_updated,
        metadata = atlassian_sync_state.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      SYNC_NAME,
      patch.checkpoint || null,
      patch.lastAttemptAt || null,
      patch.lastSuccessfulSyncAt || null,
      patch.lastResult || null,
      patch.lastErrorCode || null,
      patch.lastErrorMessage || null,
      patch.alertsImported || 0,
      patch.alertsUpdated || 0,
      JSON.stringify(metadata),
    ],
  );
}

async function syncOpsAlerts(options = {}) {
  await ensureStorage();

  if (syncInProgress) {
    const error = new Error('Atlassian Operations sync is already running.');
    error.status = 409;
    error.code = 'sync_already_running';
    throw error;
  }

  syncInProgress = true;

  const config = await getEffectiveConfig();
  const state = await getState();
  const startedAt = new Date();
  const syncRun = await createSyncRun(options.syncType || 'manual', { requestedOptions: { ...options, tokens: undefined } });
  const counts = {
    failed: 0,
    fetched: 0,
    inserted: 0,
    unchanged: 0,
    updated: 0,
  };

  await updateStatePatch({
    lastAttemptAt: startedAt.toISOString(),
    lastResult: 'running',
  });

  try {
    assertOpsConfig(config);

    const windowStart = options.from
      ? new Date(options.from)
      : state?.checkpoint
        ? new Date(state.checkpoint)
        : new Date(Date.now() - config.initialSyncDays * 24 * 60 * 60 * 1000);
    const windowEnd = options.to ? new Date(options.to) : startedAt;

    if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
      const error = new Error('Invalid Atlassian Operations sync date range.');
      error.status = 400;
      error.code = 'invalid_date_range';
      throw error;
    }

    const pageSize = Math.min(Math.max(Number(options.pageSize || DEFAULT_PAGE_SIZE), 1), DEFAULT_PAGE_SIZE);
    const sort = options.sort === 'createdAt' ? 'createdAt' : 'updatedAt';
    let offset = Math.max(Number(options.offset || 0), 0);
    let hasNextPage = true;

    while (hasNextPage) {
      if (offset >= MAX_RETRIEVABLE_ALERTS_PER_WINDOW) {
        const error = new Error('JSM Operations returned more than the safe 20,000 alert window. Use a smaller date range.');
        error.status = 400;
        error.code = 'ops_window_too_large';
        throw error;
      }

      const page = await listAlertsPage({
        from: windowStart.getTime(),
        offset,
        size: pageSize,
        sort,
        to: windowEnd.getTime(),
      });
      const alerts = getValuesFromListResponse(page.body);

      counts.fetched += alerts.length;

      for (const listedAlert of alerts) {
        try {
          const listedId = getAlertExternalId(listedAlert);
          // The learning-dataset refresh needs only the bounded Operations list
          // payload.  Keeping this mode explicit prevents N+1 detail/child/Jira
          // calls while preserving the full ingestion path for existing users.
          const foundationOnly = options.foundationOnly === true;
          const detail = foundationOnly
            ? listedAlert
            : await getAlertDetails(listedId).catch(() => listedAlert);
          const mergedAlert = { ...listedAlert, ...detail };
          const jiraKey = findJiraKeys(mergedAlert)[0] || null;
          const [childData, jiraEnrichment] = foundationOnly
            ? [
                {
                  raw: {},
                  statuses: {
                    attachments: 'not_requested_for_dataset_refresh',
                    logs: 'not_requested_for_dataset_refresh',
                    notes: 'not_requested_for_dataset_refresh',
                  },
                },
                { jira: null, error: { code: 'not_requested_for_dataset_refresh' } },
              ]
            : await Promise.all([
                getChildResources(listedId),
                enrichJira(jiraKey),
              ]);
          const normalized = normalizeAlert(mergedAlert, childData, jiraEnrichment);
          const client = await db.pool.connect();

          try {
            await client.query('BEGIN');
            const upserted = await upsertAlert(client, normalized);
            if (!foundationOnly) {
              await storeChildResources(client, upserted.id, childData);
            }
            await storeResponders(client, upserted.id, normalized.responders);
            await client.query(
              `
                INSERT INTO raw_alerts (
                  source_tool,
                  source_type,
                  source_alert_id,
                  normalized_alert_id,
                  raw_payload,
                  processing_status
                )
                SELECT 'JSM Operations', 'monitoring', $1, $2, $3::jsonb, 'normalized'
                WHERE NOT $4::boolean
                   OR NOT EXISTS (
                     SELECT 1
                     FROM raw_alerts existing
                     WHERE existing.source_tool = 'JSM Operations'
                       AND existing.source_alert_id = $1
                       AND existing.normalized_alert_id = $2
                       AND existing.raw_payload = $3::jsonb
                   )
              `,
              [normalized.source_alert_id, upserted.id, JSON.stringify(normalized.raw_payload || {}), foundationOnly],
            );
            await client.query('COMMIT');

            liveOccurrenceAutomationService.enqueue(
              upserted.id,
              upserted.inserted ? 'NEW_ALERT_INGESTED' : 'ALERT_EVIDENCE_UPDATED',
            );

            if (upserted.inserted) {
              counts.inserted += 1;
            } else {
              counts.updated += 1;
            }
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        } catch (error) {
          counts.failed += 1;
          console.error('Atlassian Operations alert sync item failed', sanitizeError(error));
        }
      }

      hasNextPage = hasNextAlertsPage({ alerts, offset, page, size: pageSize });
      offset += alerts.length;
    }

    const completedAt = new Date();
    await updateStatePatch({
      checkpoint: windowEnd.toISOString(),
      lastErrorCode: null,
      lastErrorMessage: null,
      lastResult: 'success',
      lastSuccessfulSyncAt: completedAt.toISOString(),
      alertsImported: counts.inserted,
      alertsUpdated: counts.updated,
      metadata: {
        lastFetched: counts.fetched,
        lastFailed: counts.failed,
        lastSyncRunId: syncRun.id,
      },
    });
    await finishSyncRun(syncRun.id, 'success', counts);

    return {
      success: true,
      ...counts,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      syncRunId: syncRun.id,
    };
  } catch (error) {
    const sanitized = sanitizeError(error);
    const completedAt = new Date();

    await updateStatePatch({
      lastErrorCode: sanitized.code,
      lastErrorMessage: sanitized.message,
      lastResult: 'failed',
      metadata: {
        lastFailedSyncRunId: syncRun.id,
      },
    });
    await finishSyncRun(syncRun.id, 'failed', counts, sanitized);
    throw error;
  } finally {
    syncInProgress = false;
  }
}

async function getStatus() {
  await ensureStorage();
  const config = await getEffectiveConfig();
  const state = await getState();
  const missing = getMissingConfig(config);
  const connections = await getClientStatusesAsync();

  return {
    configured: missing.length === 0,
    connected: ['success', 'connection_test_success'].includes(state?.last_result),
    connections,
    pollingEnabled: config.pollingEnabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    readOnly: !connections.operationsWrite.enabled,
    missingConfig: missing,
    opsBaseUrlConfigured: Boolean(config.cloudId),
    jiraBaseUrlConfigured: Boolean(config.cloudId),
    lastAttemptAt: state?.last_attempt_at || null,
    lastSuccessfulSyncAt: state?.last_successful_sync_at || null,
    lastResult: state?.last_result || null,
    lastErrorCode: state?.last_error_code || null,
    lastErrorMessage: state?.last_error_message || null,
    alertsFetched: state?.metadata?.lastFetched || 0,
    alertsFailed: state?.metadata?.lastFailed || 0,
    alertsImported: state?.alerts_imported || 0,
    alertsUpdated: state?.alerts_updated || 0,
  };
}

async function testConnection() {
  await ensureStorage();
  const config = await getEffectiveConfig();
  const statuses = await getClientStatusesAsync();

  const result = {
    configured: Boolean(config.email && config.cloudId),
    jiraRead: statuses.jiraRead,
    operationsRead: statuses.operationsRead,
    operationsWrite: statuses.operationsWrite,
    jiraWrite: statuses.jiraWrite,
    jsmRead: statuses.jsmRead,
    jsmWrite: statuses.jsmWrite,
    ok: false,
  };

  async function markReadStatus(key, callback) {
    try {
      const apiResponse = await callback();

      result[key] = {
        ...result[key],
        connected: true,
        connectionTested: true,
        error: null,
        status: apiResponse.status,
      };
    } catch (error) {
      result[key] = {
        ...result[key],
        connected: false,
        connectionTested: true,
        error: sanitizeError(error),
      };
    }
  }

  await Promise.all([
    markReadStatus('operationsRead', () => listAlertsPage({
      from: Date.now() - 60 * 60 * 1000,
      offset: 0,
      size: 1,
      to: Date.now(),
    })),
    markReadStatus('jiraRead', () => jiraReadClient.request('/rest/api/3/myself')),
    markReadStatus('jsmRead', () => jsmReadClient.request('/rest/servicedeskapi/servicedesk', {
      query: {
        limit: 1,
        start: 0,
      },
    })),
  ]);

  for (const key of ['operationsWrite', 'jiraWrite', 'jsmWrite']) {
    result[key] = {
      ...result[key],
      connected: false,
      connectionTested: false,
      error: result[key].configured
        ? null
        : result[key].error,
      message: result[key].enabled
        ? 'Configured. No write action was executed during the connection test.'
        : 'Configured status checked only. Write actions are disabled.',
    };
  }

  result.ok = Boolean(result.operationsRead.connected)
    && (!result.jiraRead.configured || result.jiraRead.connected)
    && (!result.jsmRead.configured || result.jsmRead.connected);
  result.message = result.ok
    ? 'Atlassian read access verified.'
    : 'Atlassian test completed with warnings. Check the lane status cards.';
  await updateStatePatch({
    lastAttemptAt: new Date().toISOString(),
    lastErrorCode: result.ok ? null : result.operationsRead.error?.code || result.jiraRead.error?.code || result.jsmRead.error?.code || null,
    lastErrorMessage: result.ok ? null : result.operationsRead.error?.message || result.jiraRead.error?.message || result.jsmRead.error?.message || null,
    lastResult: result.ok ? 'connection_test_success' : 'connection_test_warning',
  });

  return result;
}

async function getSyncRuns(limit = 20) {
  await ensureStorage();
  const result = await db.query(
    `
      SELECT
        id,
        integration_name,
        sync_type,
        status,
        started_at,
        completed_at,
        fetched,
        inserted,
        updated,
        unchanged,
        failed,
        error_code,
        error_message,
        metadata
      FROM integration_sync_runs
      WHERE integration_name = 'atlassian-jsm-operations'
      ORDER BY started_at DESC
      LIMIT $1
    `,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );

  return result.rows;
}

function isTerminalStatus(status) {
  return ['closed', 'resolved', 'recovered', 'auto-resolved'].includes(String(status || '').toLowerCase());
}

function getOpsAlertIdFromRow(row) {
  const details = row?.extracted_details || {};
  const tinyId = String(firstValue(
    row?.atlassian_ops_tiny_id,
    details.jsm_ops?.tiny_id,
    details.jsm_ops?.tinyId,
    details.normalized_alert?.tiny_id,
    details.normalized_alert?.tinyId,
    '',
  ));
  const alias = String(firstValue(
    row?.atlassian_ops_alias,
    details.jsm_ops?.alias,
    details.normalized_alert?.alias,
    '',
  ));
  const candidates = [
    row?.atlassian_ops_alert_id,
    details.jsm_ops?.alert_id,
    details.normalized_alert?.ops_alert_id,
    details.normalized_alert?.alert_id,
    row?.source_alert_id,
  ]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value).trim())
    .filter(Boolean);

  return candidates.find((value) => !/^\d+$/.test(value) && value !== tinyId && value !== alias)
    || candidates[0];
}

function createOpsActionError(message, code, status = 502, safeDetails = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.safeMessage = message;
  if (safeDetails) error.safeDetails = safeDetails;
  return error;
}

function toBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function assertCanonicalOpsAlertId(row) {
  const canonicalAlertId = String(getOpsAlertIdFromRow(row) || '').trim();
  const details = row?.extracted_details || {};
  const tinyId = String(firstValue(
    row?.atlassian_ops_tiny_id,
    details.jsm_ops?.tiny_id,
    details.jsm_ops?.tinyId,
    details.normalized_alert?.tiny_id,
    details.normalized_alert?.tinyId,
    '',
  ));
  const alias = String(firstValue(
    row?.atlassian_ops_alias,
    details.jsm_ops?.alias,
    details.normalized_alert?.alias,
    '',
  ));

  if (!canonicalAlertId) {
    throw createOpsActionError(
      'This alert is missing its canonical JSM Operations alert ID.',
      'MISSING_OPS_ALERT_ID',
      400,
    );
  }

  if (/^\d+$/.test(canonicalAlertId) || canonicalAlertId === tinyId || canonicalAlertId === alias) {
    throw createOpsActionError(
      'This alert does not contain a safe canonical JSM Operations alert ID.',
      'INVALID_OPS_ALERT_ID',
      409,
    );
  }

  return canonicalAlertId;
}

function assertAcknowledgeEligible(alert) {
  if (!alert || typeof alert !== 'object' || !firstValue(alert.id, alert.alertId, alert.alert_id)) {
    throw createOpsActionError('The JSM Operations alert was not found.', 'OPS_ALERT_NOT_FOUND', 404);
  }

  const rawStatus = String(firstValue(alert.status, alert.state, '')).trim().toLowerCase();
  const acknowledged = toBoolean(firstValue(alert.acknowledged, alert.isAcknowledged, false));
  const snoozed = toBoolean(firstValue(alert.snoozed, alert.isSnoozed, false)) || /snooz/.test(rawStatus);
  const terminal = Boolean(firstValue(alert.closeTime, alert.closedAt, alert.closed_at, alert.endTime))
    || /closed|resolved|recovered|auto-resolved/.test(rawStatus);

  if (terminal) {
    throw createOpsActionError(
      'This JSM Operations alert is already closed remotely.',
      'INVALID_REMOTE_STATE',
      409,
      { upstreamStatus: rawStatus || 'closed' },
    );
  }

  if (acknowledged || /ack/.test(rawStatus)) {
    throw createOpsActionError(
      'This JSM Operations alert is already acknowledged.',
      'ALREADY_ACKNOWLEDGED',
      409,
      { upstreamStatus: rawStatus || 'acknowledged' },
    );
  }

  if (snoozed) {
    throw createOpsActionError(
      'Snoozed JSM Operations alerts cannot be acknowledged by this application.',
      'ALERT_SNOOZED',
      409,
      { upstreamStatus: rawStatus || 'snoozed' },
    );
  }

  if (!['open', 'firing', 'triggered', 'active', 'unacknowledged'].includes(rawStatus)) {
    throw createOpsActionError(
      'The current JSM Operations alert state is not eligible for acknowledgement.',
      'INVALID_REMOTE_STATE',
      409,
      { upstreamStatus: rawStatus || 'unknown' },
    );
  }

  return { acknowledged: false, status: rawStatus };
}

function getRequestStatusState(payload = {}) {
  const processedAt = parseDate(payload.processedAt);

  if (processedAt && payload.isSuccess === true) {
    return { outcome: 'success', processedAt };
  }

  if (processedAt && payload.isSuccess === false) {
    return { outcome: 'failure', processedAt };
  }

  return { outcome: 'pending', processedAt: null };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollOpsRequestStatus({
  client = opsReadClient,
  initialDelayMs = ACKNOWLEDGE_POLLING_DEFAULTS.initialDelayMs,
  maxDelayMs = ACKNOWLEDGE_POLLING_DEFAULTS.maxDelayMs,
  maxDurationMs = ACKNOWLEDGE_POLLING_DEFAULTS.maxDurationMs,
  now = () => Date.now(),
  requestId,
  sleep = delay,
}) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    throw createOpsActionError(
      'Atlassian accepted the acknowledgement without returning a request ID.',
      'OPS_ACKNOWLEDGE_REQUEST_ID_MISSING',
      502,
      { outcome: 'unknown', stage: 'acceptance' },
    );
  }

  const startedAt = now();
  const boundedInitialDelay = Math.max(Number(initialDelayMs) || 0, 0);
  const boundedMaxDelay = Math.max(Number(maxDelayMs) || boundedInitialDelay || 1, boundedInitialDelay || 1);
  const boundedDuration = Math.max(Number(maxDurationMs) || 1, 1);
  const maximumAttempts = Math.max(Math.ceil(boundedDuration / Math.max(boundedInitialDelay || 1, 1)) + 1, 2);
  let nextDelay = boundedInitialDelay;
  let attempts = 0;

  if (nextDelay > 0) await sleep(nextDelay);

  while (attempts < maximumAttempts && now() - startedAt <= boundedDuration) {
    attempts += 1;
    let response;

    try {
      response = await client.request(
        `/v1/alerts/requests/${encodeURIComponent(normalizedRequestId)}`,
        { method: 'GET' },
      );
    } catch (error) {
      error.outcome = 'unknown';
      error.safeDetails = {
        outcome: 'unknown',
        requestId: normalizedRequestId,
        stage: 'request_status',
      };
      throw error;
    }

    const state = getRequestStatusState(response.body || {});
    if (state.outcome === 'success') {
      return {
        attempts,
        body: response.body || {},
        httpStatus: response.status,
        processedAt: state.processedAt,
      };
    }

    if (state.outcome === 'failure') {
      throw createOpsActionError(
        'Atlassian reported that the acknowledgement request failed.',
        'OPS_ACKNOWLEDGE_REQUEST_FAILED',
        502,
        {
          outcome: 'failed',
          requestId: normalizedRequestId,
          stage: 'request_status',
          upstreamStatus: response.body?.status || null,
        },
      );
    }

    if (now() - startedAt >= boundedDuration) break;
    nextDelay = Math.min(Math.max(nextDelay * 2, 1), boundedMaxDelay);
    await sleep(nextDelay);
  }

  throw createOpsActionError(
    'Atlassian acknowledgement request status could not be verified before the polling deadline.',
    'OPS_ACKNOWLEDGE_STATUS_TIMEOUT',
    504,
    {
      attempts,
      outcome: 'unknown',
      requestId: normalizedRequestId,
      stage: 'request_status',
    },
  );
}

function getNextLogCursor(nextLink) {
  if (!nextLink) return null;

  try {
    return new URL(String(nextLink), 'https://atlassian.invalid').searchParams.get('after');
  } catch {
    return null;
  }
}

async function getOpsAcknowledgementLogs({ alertId, client = opsReadClient, maxPages = 3 }) {
  const values = [];
  const seenCursors = new Set();
  let after;

  for (let page = 0; page < Math.max(Number(maxPages) || 1, 1); page += 1) {
    const response = await client.request(
      `/v1/alerts/${encodeURIComponent(alertId)}/logs`,
      { method: 'GET', query: { after, size: 100 } },
    );
    const pageValues = Array.isArray(response.body?.values) ? response.body.values : [];
    values.push(...pageValues);

    const nextCursor = getNextLogCursor(response.body?.links?.next);
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  return values;
}

function verifyAcknowledgedAlert(alert = {}) {
  const acknowledged = toBoolean(firstValue(alert.acknowledged, alert.isAcknowledged, false));
  const acknowledgedAt = parseDate(firstValue(alert.ackTime, alert.acknowledgedAt, alert.acknowledged_at));
  const updatedAt = parseDate(firstValue(alert.updatedAt, alert.updated_at));
  const upstreamStatus = String(firstValue(alert.status, alert.state, '')).trim();

  if (!acknowledged || !acknowledgedAt || !updatedAt || !upstreamStatus) {
    throw createOpsActionError(
      'Atlassian accepted the acknowledgement, but alert read-back did not verify the expected fields.',
      'OPS_ACKNOWLEDGE_READBACK_NOT_VERIFIED',
      502,
      {
        acknowledged,
        ackTimePresent: Boolean(acknowledgedAt),
        outcome: 'unknown',
        stage: 'read_back',
        statusPresent: Boolean(upstreamStatus),
        updatedAtPresent: Boolean(updatedAt),
      },
    );
  }

  return {
    acknowledged,
    acknowledgedAt,
    normalizedStatus: normalizeStatus(alert),
    updatedAt,
    upstreamStatus,
  };
}

function findVerifiedAcknowledgementLog(logs, { acknowledgedAt, requestedAt }) {
  const requestedAtMs = new Date(requestedAt).getTime();
  const acknowledgedAtMs = new Date(acknowledgedAt).getTime();
  const notBefore = Number.isFinite(requestedAtMs)
    ? requestedAtMs - ACKNOWLEDGEMENT_LOG_CLOCK_TOLERANCE_MS
    : Number.NEGATIVE_INFINITY;

  const candidates = asArray(logs)
    .filter((entry) => String(entry?.logType || '').toLowerCase() === 'alertaction')
    .filter((entry) => {
      const message = String(firstValue(entry?.log, entry?.message, ''));
      return /acknowledg/i.test(message) && !/unacknowledg/i.test(message);
    })
    .map((entry) => ({
      entry,
      logTime: parseDate(firstValue(entry.logTime, entry.createdAt, entry.timestamp)),
      owner: getDisplayName(entry.owner),
    }))
    .filter((candidate) => candidate.logTime && candidate.owner)
    .filter((candidate) => new Date(candidate.logTime).getTime() >= notBefore)
    .sort((left, right) => {
      if (Number.isFinite(acknowledgedAtMs)) {
        return Math.abs(new Date(left.logTime).getTime() - acknowledgedAtMs)
          - Math.abs(new Date(right.logTime).getTime() - acknowledgedAtMs);
      }
      return new Date(right.logTime).getTime() - new Date(left.logTime).getTime();
    });

  return candidates[0] || null;
}

async function executeVerifiedOpsAcknowledge({
  canonicalAlertId,
  now = () => Date.now(),
  opsRead = opsReadClient,
  opsWrite = opsWriteClient,
  polling = {},
  requestedAt = new Date(now()).toISOString(),
  sleep = delay,
}) {
  const normalizedAlertId = String(canonicalAlertId || '').trim();
  if (!normalizedAlertId || /^\d+$/.test(normalizedAlertId)) {
    throw createOpsActionError(
      'A canonical JSM Operations alert ID is required for acknowledgement.',
      'INVALID_OPS_ALERT_ID',
      409,
    );
  }

  const beforeResponse = await opsRead.request(
    `/v1/alerts/${encodeURIComponent(normalizedAlertId)}`,
    { method: 'GET' },
  );
  const beforeAlert = beforeResponse.body || {};
  const eligibility = assertAcknowledgeEligible(beforeAlert);

  let acceptance;
  try {
    acceptance = await opsWrite.request(
      `/v1/alerts/${encodeURIComponent(normalizedAlertId)}/acknowledge`,
      { method: 'POST', retry: false },
    );
  } catch (error) {
    const ambiguous = error.status >= 500
      || ['NETWORK_OR_TLS_FAILURE', 'REQUEST_TIMEOUT'].includes(error.code);
    error.outcome = ambiguous ? 'unknown' : 'failed';
    error.safeDetails = {
      outcome: error.outcome,
      stage: 'acceptance',
    };
    throw error;
  }

  const requestId = String(acceptance.body?.requestId || '').trim();
  if (acceptance.status !== 202 || !requestId) {
    throw createOpsActionError(
      'Atlassian did not return the documented acknowledgement acceptance response.',
      'OPS_ACKNOWLEDGE_ACCEPTANCE_NOT_VERIFIED',
      502,
      {
        httpStatus: acceptance.status,
        outcome: 'unknown',
        requestId: requestId || null,
        stage: 'acceptance',
      },
    );
  }

  const requestStatus = await pollOpsRequestStatus({
    client: opsRead,
    now,
    requestId,
    sleep,
    ...polling,
  });

  let afterResponse;
  try {
    afterResponse = await opsRead.request(
      `/v1/alerts/${encodeURIComponent(normalizedAlertId)}`,
      { method: 'GET' },
    );
  } catch (error) {
    error.outcome = 'unknown';
    error.safeDetails = { outcome: 'unknown', requestId, stage: 'read_back' };
    throw error;
  }

  const afterAlert = afterResponse.body || {};
  const verifiedAlert = verifyAcknowledgedAlert(afterAlert);
  let logs;

  try {
    logs = await getOpsAcknowledgementLogs({ alertId: normalizedAlertId, client: opsRead });
  } catch (error) {
    error.outcome = 'unknown';
    error.safeDetails = { outcome: 'unknown', requestId, stage: 'log_verification' };
    throw error;
  }

  const acknowledgementLog = findVerifiedAcknowledgementLog(logs, {
    acknowledgedAt: verifiedAlert.acknowledgedAt,
    requestedAt,
  });

  if (!acknowledgementLog) {
    throw createOpsActionError(
      'Atlassian alert logs did not verify the acknowledgement lifecycle event.',
      'OPS_ACKNOWLEDGE_LOG_NOT_VERIFIED',
      502,
      { outcome: 'unknown', requestId, stage: 'log_verification' },
    );
  }

  return {
    acknowledgementLog,
    alert: afterAlert,
    canonicalAlertId: normalizedAlertId,
    completedAt: requestStatus.processedAt,
    httpAcceptanceStatus: acceptance.status,
    previousStatus: eligibility.status,
    readBackVerified: true,
    requestId,
    requestStatus: requestStatus.body,
    requestedAt,
    tinyId: firstValue(afterAlert.tinyId, beforeAlert.tinyId, null),
    upstreamResult: requestStatus.body?.status || null,
    verifiedAlert,
    logVerified: true,
  };
}

function normalizeResponderPayload(payload = {}) {
  const sourceResponders = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.responders)
      ? payload.responders
      : payload.responder
        ? [payload.responder]
        : [];
  const responders = sourceResponders
    .map((responder) => {
      if (typeof responder === 'string') {
        const id = responder.trim();
        return id ? { id, type: 'user' } : null;
      }

      if (!responder || typeof responder !== 'object') {
        return null;
      }

      const id = firstValue(
        responder.id,
        responder.accountId,
        responder.account_id,
        responder.teamId,
        responder.team_id,
        responder.value,
        responder.name,
      );

      if (!id) {
        return null;
      }

      return {
        ...responder,
        id: String(id),
        type: String(firstValue(responder.type, responder.responderType, responder.teamId ? 'team' : 'user')),
      };
    })
    .filter(Boolean);

  if (responders.length === 0) {
    const error = new Error('At least one responder is required.');
    error.status = 400;
    error.code = 'MISSING_RESPONDER';
    throw error;
  }

  return { responders };
}

function buildOpsActionRequest(action, payload = {}) {
  const normalizedAction = String(action || '').toLowerCase();

  if (normalizedAction === 'acknowledge') {
    return {
      eventType: 'jsm_ops_alert_acknowledged',
      pathSuffix: 'acknowledge',
      nextStatus: 'acknowledged',
    };
  }

  if (normalizedAction === 'assign') {
    return {
      body: normalizeResponderPayload(payload),
      eventType: 'jsm_ops_responder_assigned',
      pathSuffix: 'responders',
      nextStatus: null,
    };
  }

  if (normalizedAction === 'snooze') {
    const snoozedUntil = firstValue(payload.snoozedUntil, payload.until, payload.snoozeUntil);

    if (!snoozedUntil || Number.isNaN(new Date(snoozedUntil).getTime())) {
      const error = new Error('A valid snoozedUntil timestamp is required to snooze an alert.');
      error.status = 400;
      error.code = 'INVALID_SNOOZE_UNTIL';
      throw error;
    }

    return {
      body: {
        ...payload,
        snoozedUntil: new Date(snoozedUntil).toISOString(),
      },
      eventType: 'jsm_ops_alert_snoozed',
      pathSuffix: 'snooze',
      nextStatus: 'investigating',
    };
  }

  if (normalizedAction === 'close') {
    return {
      // Atlassian Operations documents close as an empty-body action. Keep any
      // operator-supplied reason in our audit record instead of sending an
      // undocumented payload upstream.
      body: {},
      eventType: 'jsm_ops_alert_closed',
      pathSuffix: 'close',
      nextStatus: 'closed',
    };
  }

  if (normalizedAction === 'note') {
    const note = String(firstValue(payload.note, payload.body, payload.text, '')).trim();

    if (!note) {
      const error = new Error('Note cannot be empty.');
      error.status = 400;
      error.code = 'EMPTY_NOTE';
      throw error;
    }

    return {
      body: { note },
      eventType: 'jsm_ops_note_added',
      pathSuffix: 'notes',
      nextStatus: null,
    };
  }

  const error = new Error(`Unsupported Operations action: ${action}.`);
  error.status = 400;
  error.code = 'UNSUPPORTED_OPS_ACTION';
  throw error;
}

async function performVerifiedOpsAcknowledge(localAlertId, payload = {}) {
  // Fail before reading upstream state. A disabled write request must never
  // result in any database work or Atlassian request, including a preliminary GET.
  opsWriteClient.assertEnvironmentWriteEnabled();
  await ensureStorage();

  const currentResult = await db.query('SELECT * FROM alerts WHERE id = $1', [localAlertId]);
  const currentAlert = currentResult.rows[0];

  if (!currentAlert) return null;

  if (![OPS_SOURCE, 'atlassian_ops'].includes(currentAlert.source)) {
    throw createOpsActionError(
      'This action is only available for JSM Operations alerts.',
      'NOT_JSM_OPS_ALERT',
      400,
    );
  }

  const canonicalAlertId = assertCanonicalOpsAlertId(currentAlert);
  const requestedBy = payload.actor || payload.acknowledgedBy || 'Website operator';
  const requestedAt = new Date().toISOString();
  const verified = await executeVerifiedOpsAcknowledge({
    canonicalAlertId,
    requestedAt,
  });
  const acknowledgedBy = verified.acknowledgementLog.owner;
  const acknowledgedAt = verified.verifiedAlert.acknowledgedAt;
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    const lockedResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [localAlertId]);
    const lockedAlert = lockedResult.rows[0];

    if (!lockedAlert) {
      throw createOpsActionError(
        'The local alert disappeared after Atlassian verified the acknowledgement.',
        'LOCAL_ALERT_CHANGED_AFTER_ACKNOWLEDGEMENT',
        409,
        { outcome: 'upstream_verified', requestId: verified.requestId },
      );
    }

    if (assertCanonicalOpsAlertId(lockedAlert) !== canonicalAlertId) {
      throw createOpsActionError(
        'The canonical Operations alert ID changed while acknowledgement was processing.',
        'LOCAL_ALERT_CHANGED_AFTER_ACKNOWLEDGEMENT',
        409,
        { outcome: 'upstream_verified', requestId: verified.requestId },
      );
    }

    const details = lockedAlert.extracted_details || {};
    const auditDetails = {
      acknowledgedAt,
      acknowledgedBy,
      action: 'acknowledge',
      canonicalAlertId,
      completedAt: verified.completedAt,
      errorCode: null,
      errorMessage: null,
      httpAcceptanceStatus: verified.httpAcceptanceStatus,
      logVerified: verified.logVerified,
      previousStatus: verified.previousStatus,
      readBackVerified: verified.readBackVerified,
      requestId: verified.requestId,
      requestedAt,
      requestedBy,
      tinyId: verified.tinyId === null ? null : String(verified.tinyId),
      upstreamResult: verified.upstreamResult,
      verifiedNewStatus: verified.verifiedAlert.normalizedStatus,
    };
    const nextDetails = {
      ...details,
      jsm_ops: {
        ...(details.jsm_ops || {}),
        last_write_action: auditDetails,
      },
    };

    await client.query(
      `
        UPDATE alerts
        SET
          status = $2,
          acknowledged = true,
          acknowledged_by = $3,
          acknowledged_at = $4,
          acknowledgement_source = 'jsm_operations',
          extracted_details = $5::jsonb,
          atlassian_ops_tiny_id = COALESCE($6, atlassian_ops_tiny_id),
          atlassian_last_synced_at = NOW(),
          last_seen_at = $7,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        localAlertId,
        verified.verifiedAlert.normalizedStatus,
        acknowledgedBy,
        acknowledgedAt,
        JSON.stringify(nextDetails),
        verified.tinyId === null ? null : String(verified.tinyId),
        verified.verifiedAlert.updatedAt,
      ],
    );

    await client.query(
      `
        INSERT INTO audit_events (alert_id, event_type, actor, source, details)
        VALUES ($1, 'jsm_ops_alert_acknowledged', $2, 'website', $3::jsonb)
      `,
      [localAlertId, requestedBy, JSON.stringify(auditDetails)],
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    alert: await alertService.getAlertById(localAlertId),
    atlassianStatus: verified.httpAcceptanceStatus,
    metadata: {
      completedAt: verified.completedAt,
      logVerified: true,
      readBackVerified: true,
      requestId: verified.requestId,
    },
    opsAlertId: canonicalAlertId,
    success: true,
  };
}

async function performOpsAlertAction(localAlertId, action, payload = {}) {
  if (String(action || '').toLowerCase() === 'acknowledge') {
    return performVerifiedOpsAcknowledge(localAlertId, payload);
  }

  await ensureStorage();
  const actor = payload.actor || payload.acknowledgedBy || payload.createdBy || payload.assignedBy || 'Website operator';
  const actionRequest = buildOpsActionRequest(action, payload);
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [localAlertId]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    if (![OPS_SOURCE, 'atlassian_ops'].includes(currentAlert.source)) {
      const error = new Error('This action is only available for JSM Operations alerts.');
      error.status = 400;
      error.code = 'NOT_JSM_OPS_ALERT';
      throw error;
    }

    const opsAlertId = getOpsAlertIdFromRow(currentAlert);

    if (!opsAlertId) {
      const error = new Error('This alert is missing its JSM Operations alert ID.');
      error.status = 400;
      error.code = 'MISSING_OPS_ALERT_ID';
      throw error;
    }

    const remoteAlert = await getAlertDetails(opsAlertId);
    const remoteStatus = normalizeStatus(remoteAlert);

    if (isTerminalStatus(remoteStatus) && action !== 'note') {
      const error = new Error('This JSM Operations alert is already closed remotely.');
      error.status = 409;
      error.code = 'INVALID_REMOTE_STATE';
      throw error;
    }

    const response = await opsWriteClient.request(`/v1/alerts/${encodeURIComponent(opsAlertId)}/${actionRequest.pathSuffix}`, {
      body: actionRequest.body,
      method: 'POST',
    });

    const details = currentAlert.extracted_details || {};
    const nextDetails = {
      ...details,
      jsm_ops: {
        ...(details.jsm_ops || {}),
        last_write_action: {
          action,
          actor,
          metadata: response.body || {},
          performed_at: new Date().toISOString(),
          request_payload: actionRequest.body,
          status: response.status,
        },
      },
    };
    const updatedResponders = action === 'assign'
      ? [
        ...(Array.isArray(currentAlert.responders) ? currentAlert.responders : []),
        ...actionRequest.body.responders.map((responder) => ({
          ...responder,
          assignedAt: new Date().toISOString(),
          source: 'jsm_operations',
        })),
      ]
      : currentAlert.responders || [];

    await client.query(
      `
        UPDATE alerts
        SET
          status = COALESCE($2, status),
          acknowledged = CASE WHEN $3 THEN true ELSE acknowledged END,
          acknowledged_by = CASE WHEN $3 THEN $4 ELSE acknowledged_by END,
          acknowledged_at = CASE WHEN $3 THEN COALESCE(acknowledged_at, NOW()) ELSE acknowledged_at END,
          acknowledgement_source = CASE WHEN $3 THEN 'jsm_operations' ELSE acknowledgement_source END,
          responders = $5::jsonb,
          extracted_details = $6::jsonb,
          last_seen_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        localAlertId,
        actionRequest.nextStatus,
        action === 'acknowledge',
        actor,
        JSON.stringify(updatedResponders),
        JSON.stringify(nextDetails),
      ],
    );

    if (action === 'note') {
      await client.query(
        `
          INSERT INTO alert_notes (alert_id, note, created_by, source, raw_payload)
          VALUES ($1, $2, $3, 'jsm_operations', $4::jsonb)
        `,
        [localAlertId, actionRequest.body.note, actor, JSON.stringify(response.body || {})],
      );
    }

    await client.query(
      `
        INSERT INTO audit_events (alert_id, event_type, actor, source, details)
        VALUES ($1, $2, $3, 'website', $4::jsonb)
      `,
      [
        localAlertId,
        actionRequest.eventType,
        actor,
        JSON.stringify({
          action,
          alertSource: currentAlert.source,
          reason: payload.reason || null,
          opsAlertId,
          remoteStatus,
          result: 'success',
          responseStatus: response.status,
          responseMetadata: response.body || {},
        }),
      ],
    );

    await client.query('COMMIT');

    return {
      alert: await alertService.getAlertById(localAlertId),
      atlassianStatus: response.status,
      metadata: response.body || {},
      opsAlertId,
      success: true,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function startPolling() {
  if (pollingStarted) {
    return;
  }

  const config = await getEffectiveConfig().catch((error) => {
    const sanitized = sanitizeError(error);
    console.error('Atlassian Operations polling could not read configuration', sanitized);
    return null;
  });

  if (!config?.pollingEnabled) {
    return;
  }

  pollingStarted = true;
  const runPoll = () => {
    // The rolling poll keeps the authoritative occurrence population current.
    // Detail, child-resource, Jira, and monitoring evidence enrichment remain
    // separate bounded workflows rather than an N+1 operation every 30 seconds.
    syncOpsAlerts({ foundationOnly: true, syncType: 'poll' }).catch((error) => {
      const sanitized = sanitizeError(error);

      if (!['missing_configuration', 'http_401', 'http_403'].includes(String(sanitized.code))) {
        console.error('Atlassian Operations polling failed', sanitized);
      }
    });
  };
  // Recover the checkpoint immediately after a restart. Waiting one full
  // interval left a predictable ingestion gap whenever polling had been
  // disabled or the backend had been offline.
  setImmediate(runPoll);
  pollTimer = setInterval(runPoll, config.pollIntervalSeconds * 1000);
  pollTimer.unref?.();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = null;
  pollingStarted = false;
}

module.exports = {
  ACKNOWLEDGE_POLLING_DEFAULTS,
  assertAcknowledgeEligible,
  assertCanonicalOpsAlertId,
  buildOpsActionRequest,
  ensureStorage,
  executeVerifiedOpsAcknowledge,
  findVerifiedAcknowledgementLog,
  findJiraKeys,
  getRequestStatusState,
  getStatus,
  getSyncRuns,
  hasNextAlertsPage,
  normalizeAlert,
  opsRequest,
  performVerifiedOpsAcknowledge,
  performOpsAlertAction,
  pollOpsRequestStatus,
  startPolling,
  stopPolling,
  syncOpsAlerts,
  testConnection,
  upsertAlert,
};
