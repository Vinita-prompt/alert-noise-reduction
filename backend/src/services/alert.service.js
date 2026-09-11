const crypto = require('crypto');
const db = require('../config/db');
const classificationService = require('./classification.service');
const {
  DECISION_LAYER_STATE,
  notEvaluatedMetadata,
  retiredDecisionError,
} = require('../config/decisionLayer');
const alertDeduplication = require('./alertDeduplication.service');
const integrationService = require('./integration.service');
const jiraService = require('./jira.service');
const slackParser = require('./slackParser.service');
const slackUserService = require('./slackUser.service');
const jsmOpsService = require('./atlassian/jsmOps.service');
const {
  getMonitoringSourceDefinitions,
  sourceMatchesDefinition,
} = require('./monitoringSources');
const {
  COMMAND_CENTER_TEAM,
  commandCenterAlertProjectionSql,
  commandCenterAlertSql,
  isCommandCenterAlert,
} = require('./commandCenterEligibility.service');

let alertOptionalColumnsEnsured = false;

async function ensureAlertOptionalColumns() {
  if (alertOptionalColumnsEnsured) {
    return;
  }

  await db.query(`
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS jira_ticket_id VARCHAR(50);
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS raw_payload JSONB;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS extracted_details JSONB;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'monitoring';
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_alert_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS confidence_score INTEGER;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS duplicate_signature TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS correlation_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledgement_source TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalation_status BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalation_reason TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS responders JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS classification_is_legacy BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_tiny_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_alerts_ops_tiny_id
      ON alerts(atlassian_ops_tiny_id);

    ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_classification_check;
    ALTER TABLE alerts
      ADD CONSTRAINT alerts_classification_check
      CHECK (classification IN ('incident', 'noise', 'needs_review', 'unclassified'));
    ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_status_check;
    ALTER TABLE alerts
      ADD CONSTRAINT alerts_status_check
      CHECK (status IN ('open', 'acknowledged', 'escalated', 'investigating', 'suppressed', 'auto-resolved', 'deduplicated', 'firing', 'triggered', 'resolved', 'recovered', 'closed'));
  `);
  await db.query(`
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

    CREATE TABLE IF NOT EXISTS alert_acknowledgements (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      acknowledged_by TEXT NOT NULL,
      slack_user_id TEXT,
      acknowledgement_source TEXT NOT NULL DEFAULT 'slack',
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_escalations (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      escalation_reason TEXT NOT NULL,
      previous_severity TEXT,
      new_severity TEXT,
      responder_team TEXT,
      escalated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_relations (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      related_alert_id TEXT,
      relation_type TEXT NOT NULL DEFAULT 'related',
      relation_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT,
      source TEXT NOT NULL DEFAULT 'backend',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_notes (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'Website operator',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS external_note_id TEXT;
    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';
    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

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

    CREATE TABLE IF NOT EXISTS slack_notifications (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
      channel_id TEXT,
      message_ts TEXT,
      notification_type TEXT NOT NULL DEFAULT 'alert_acknowledgement',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TIMESTAMPTZ,
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS operations_incidents (
      incident_key TEXT PRIMARY KEY,
      summary TEXT,
      description TEXT,
      reporter JSONB,
      priority TEXT,
      status TEXT,
      status_category TEXT,
      resolution TEXT,
      source_url TEXT,
      incident_created_at TIMESTAMPTZ,
      incident_updated_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      assignee JSONB,
      labels JSONB NOT NULL DEFAULT '[]'::jsonb,
      linked_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
      root_cause_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      comments JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      incident_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE operations_incidents ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE operations_incidents ADD COLUMN IF NOT EXISTS incident_details JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGSERIAL PRIMARY KEY,
      sync_name TEXT NOT NULL,
      source TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'historical_backfill',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      alerts_fetched INTEGER NOT NULL DEFAULT 0,
      alerts_inserted INTEGER NOT NULL DEFAULT 0,
      alerts_updated INTEGER NOT NULL DEFAULT 0,
      alerts_skipped INTEGER NOT NULL DEFAULT 0,
      incidents_fetched INTEGER NOT NULL DEFAULT 0,
      incidents_stored INTEGER NOT NULL DEFAULT 0,
      incident_links_created INTEGER NOT NULL DEFAULT 0,
      cursor_value TEXT,
      request_options JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      sync_name TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      cursor_value TEXT,
      last_successful_run_id BIGINT REFERENCES sync_runs(id) ON DELETE SET NULL,
      last_successful_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_operations_incidents_status ON operations_incidents(status);
    CREATE INDEX IF NOT EXISTS idx_operations_incidents_updated ON operations_incidents(incident_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_sync_name ON sync_runs(sync_name, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged, escalation_status, received_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_source_alert_id_only ON alerts(source_alert_id);
    CREATE INDEX IF NOT EXISTS idx_alert_acknowledgements_alert_id ON alert_acknowledgements(alert_id, acknowledged_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_escalations_alert_id ON alert_escalations(alert_id, escalated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_relations_alert_id ON alert_relations(alert_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_alert_id ON audit_events(alert_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_notes_alert_id ON alert_notes(alert_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_notifications_alert_id ON slack_notifications(alert_id, created_at DESC);

    CREATE OR REPLACE VIEW alert_canonical_records AS
    SELECT
      id AS alert_id,
      source AS source_tool,
      CONCAT_WS(':', slack_channel_id, slack_message_ts) AS slack_message_id,
      COALESCE(
        extracted_details->'slack'->>'permalink',
        extracted_details->'slack_acknowledgement'->>'permalink',
        extracted_details->'slack_enrichment'->>'slack_permalink',
        source_url
      ) AS slack_permalink,
      slack_channel_id AS slack_channel,
      COALESCE(
        extracted_details->'slack_acknowledgement'->>'acknowledged_by_user_id',
        extracted_details->'slack_acknowledgement'->>'acknowledged_by_slack_user_id',
        acknowledged_by
      ) AS slack_acknowledged_by_user_id,
      extracted_details->'slack_acknowledgement'->>'acknowledged_by_name' AS slack_acknowledged_by_name,
      acknowledged_at AS slack_acknowledged_at,
      COALESCE(
        extracted_details->'normalized_alert'->>'jira_issue_key',
        extracted_details->'jira'->>'issue_key',
        jira_ticket_id
      ) AS jira_key,
      COALESCE(
        extracted_details->'slack_enrichment'->>'jira_url',
        extracted_details->'jira'->>'jira_url',
        extracted_details->'jira'->>'issue_url'
      ) AS jira_url,
      COALESCE(extracted_details->'jira'->>'summary', extracted_details->'slack_enrichment'->>'jira_summary') AS jira_summary,
      COALESCE(extracted_details->'jira'->>'description', extracted_details->'slack_enrichment'->>'jira_description') AS jira_description,
      COALESCE(extracted_details->'jira'->>'status', extracted_details->'slack_enrichment'->>'jira_status') AS jira_status,
      COALESCE(extracted_details->'jira'->>'priority', extracted_details->'slack_enrichment'->>'jira_priority') AS jira_priority,
      extracted_details->'jira'->'assignee'->>'accountId' AS jira_assignee_user_id,
      extracted_details->'jira'->'assignee'->>'displayName' AS jira_assignee_name,
      severity,
      status,
      last_seen_at,
      occurrences AS occurrence_count,
      raw_payload AS raw_slack_payload,
      COALESCE(extracted_details->'jira'->'raw_issue_payload', extracted_details->'slack_enrichment'->'raw_jira_issue_payload') AS raw_jira_payload,
      COALESCE(extracted_details->'jira'->'raw_comments_payload', extracted_details->'slack_enrichment'->'raw_jira_comments_payload') AS raw_jira_comments_payload,
      COALESCE(extracted_details->'jira'->'raw_changelog_payload', extracted_details->'slack_enrichment'->'raw_jira_changelog_payload') AS raw_jira_changelog_payload
    FROM alerts;
  `);
  alertOptionalColumnsEnsured = true;
}

function getNestedValue(object, path) {
  return path.reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : null
  ), object);
}

function getDisplayName(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value || null;
  }

  return value.displayName || value.name || value.emailAddress || null;
}

function deriveOpenClosedState(row) {
  const details = row.extracted_details || {};
  const normalizedState = getNestedValue(details, ['normalized_alert', 'state']);
  const jiraStatusCategory = String(getNestedValue(details, ['jira', 'status_category']) || '').toLowerCase();
  const jiraResolutionDate = getNestedValue(details, ['jira', 'resolution_date']);
  const status = String(row.status || '').toLowerCase();

  if (normalizedState) {
    return normalizedState;
  }

  if (
    jiraStatusCategory === 'done' ||
    jiraResolutionDate ||
    ['resolved', 'recovered', 'auto-resolved', 'closed'].includes(status)
  ) {
    return 'closed';
  }

  return 'open';
}

function getAcknowledgementState(row) {
  if (row.escalation_status) {
    return 'escalated';
  }

  if (row.acknowledged) {
    return 'acknowledged';
  }

  return 'unacknowledged';
}

function mapAlertRow(row, options = {}) {
  const includeDetails = options.includeDetails !== false;
  const classification = classificationService.normalizeClassification(row);
  const classificationLegacy = row.classification_is_legacy === true;
  const details = row.extracted_details || {};
  const normalized = details.normalized_alert || {};
  const jira = details.jira || {};
  const slackEnrichment = details.slack_enrichment || {};
  const slackDetails = details.slack || {};
  const slackAcknowledgement = details.slack_acknowledgement || slackDetails.acknowledgement || slackEnrichment.slack_acknowledgement || {};
  const slackAcknowledgedByUserId = slackAcknowledgement.acknowledged_by_slack_user_id
    || slackAcknowledgement.acknowledged_by_user_id
    || (isSlackUserId(slackAcknowledgement.acknowledged_by) ? slackAcknowledgement.acknowledged_by : null)
    || (isSlackUserId(row.acknowledged_by) ? row.acknowledged_by : null);
  const slackAssigneeUserId = slackAcknowledgement.assignee_slack_user_id
    || slackAcknowledgement.assignee_user_id
    || slackDetails.assignee_user_id
    || (isSlackUserId(slackAcknowledgement.assignee) ? slackAcknowledgement.assignee : null)
    || (isSlackUserId(slackDetails.assignee) ? slackDetails.assignee : null)
    || (isSlackUserId(slackEnrichment.slack_assignee) ? slackEnrichment.slack_assignee : null);
  const decision = details.classification || {};
  const extractedAlert = details.alert || {};
  const structuredAlert = details.structured_alert || null;
  const monitoringTool = slackEnrichment.monitoring_tool
    || normalized.monitoring_tool
    || extractedAlert.monitoring_tool
    || jira.monitoring_system_name
    || jira.source_tool
    || normalized.source_name
    || row.source;
  const monitoringEventUrl = slackEnrichment.monitoring_event_url
    || normalized.monitoring_event_url
    || extractedAlert.monitoring_event_url
    || normalized.deep_event_link
    || extractedAlert.deep_event_link
    || row.source_url;
  const jiraUrl = slackEnrichment.jira_url
    || normalized.jira_url
    || extractedAlert.jira_url
    || jira.jira_url
    || jira.issue_url
    || jira.event_link
    || null;
  const originalJiraUrl = slackEnrichment.original_jira_url
    || normalized.original_jira_url
    || extractedAlert.original_jira_url
    || jira.original_jira_url
    || jiraUrl;
  const canonicalJiraUrl = slackEnrichment.canonical_jira_url
    || normalized.canonical_jira_url
    || extractedAlert.canonical_jira_url
    || jira.canonical_jira_url
    || jira.issue_url
    || jira.event_link
    || jiraUrl;
  const operationsWriteEnabled = row.source === 'jsm_ops'
    && process.env.ATLASSIAN_OPS_WRITE_ENABLED === 'true'
    && Boolean(process.env.ATLASSIAN_OPS_WRITE_TOKEN);
  const responderTeam = row.visibility_responder_team || null;
  const responder = row.visibility_responder || null;
  const team = row.visibility_team || null;
  const visibleToCommandCenter = isCommandCenterAlert({ responderTeam, responder, team });

  return {
    id: row.id,
    title: row.title,
    service: row.service,
    application: normalized.application || row.service,
    environment: row.environment,
    severity: row.severity,
    priority: normalized.priority || jira.priority || null,
    status: row.status,
    jiraStatus: jira.status || null,
    openClosedState: deriveOpenClosedState(row),
    classification: classification.classification,
    classificationLegacy,
    classificationState: classificationLegacy
      ? 'legacy_non_authoritative'
      : classification.classification === 'unclassified' ? 'not_evaluated' : 'current',
    decisionLayer: DECISION_LAYER_STATE,
    legacyClassification: classificationLegacy ? {
      classification: classification.classification,
      noiseType: classification.noiseType,
      confidenceScore: classification.confidenceScore,
      reason: row.classification_reason,
      noiseReason: row.noise_reason,
    } : null,
    noiseType: classification.noiseType,
    confidenceScore: classification.confidenceScore,
    confidence: decision.confidence ?? (
      Number.isFinite(Number(classification.confidenceScore)) ? Number(classification.confidenceScore) / 100 : null
    ),
    source: row.source,
    sourceType: row.source_type,
    writeActionsEnabled: row.source === 'jsm_ops' ? operationsWriteEnabled : true,
    operationsWriteEnabled,
    sourceName: normalized.source_name || row.source,
    monitoringTool,
    monitoringEventUrl,
    monitoringSystemName: monitoringTool,
    sourceAlertId: row.source_alert_id,
    sourceUrl: row.source_url,
    eventLink: monitoringEventUrl || normalized.event_link || extractedAlert.event_link || row.source_url,
    deepEventLink: monitoringEventUrl || normalized.deep_event_link || extractedAlert.deep_event_link || row.source_url,
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    slackPermalink: slackDetails.permalink || slackAcknowledgement.permalink || slackEnrichment.slack_permalink || null,
    slackAssignee: slackAcknowledgement.assignee || slackDetails.assignee || slackEnrichment.slack_assignee || null,
    slackAssigneeUserId,
    slackAssigneeName: slackAcknowledgement.assignee_name || slackDetails.assignee_name || null,
    slack_assignee_user_id: slackAssigneeUserId,
    assignee_user_id: slackAssigneeUserId,
    assignee_name: slackAcknowledgement.assignee_name || slackDetails.assignee_name || null,
    slackAcknowledgementStatus: slackAcknowledgement.status || null,
    slackAcknowledged: Boolean(slackAcknowledgement.acknowledged),
    slackAcknowledgedBy: slackAcknowledgement.acknowledged_by || null,
    slackAcknowledgedByUserId,
    slackAcknowledgedByName: slackAcknowledgement.acknowledged_by_name || null,
    slack_acknowledged_by_user_id: slackAcknowledgedByUserId,
    slack_acknowledged_by_name: slackAcknowledgement.acknowledged_by_name || null,
    slackAcknowledgedAt: slackAcknowledgement.acknowledged_at || null,
    acknowledged: Boolean(row.acknowledged),
    acknowledgedStatus: getAcknowledgementState(row),
    acknowledgedBy: row.acknowledged_by,
    acknowledgedByRaw: row.acknowledged_by,
    acknowledgedByUserId: slackAcknowledgedByUserId,
    acknowledgedByName: slackAcknowledgement.acknowledged_by_name || null,
    acknowledged_by_user_id: slackAcknowledgedByUserId,
    acknowledged_by_name: slackAcknowledgement.acknowledged_by_name || null,
    acknowledgedAt: row.acknowledged_at,
    acknowledgementSource: row.acknowledgement_source,
    escalated: Boolean(row.escalation_status),
    escalationStatus: Boolean(row.escalation_status),
    escalatedAt: row.escalated_at,
    escalationReason: row.escalation_reason,
    responders: row.responders || [],
    rawPayload: includeDetails ? row.raw_payload : null,
    extractedDetails: includeDetails ? row.extracted_details : null,
    structuredAlert: includeDetails ? structuredAlert : null,
    noiseReason: row.noise_reason,
    classificationReason: row.classification_reason,
    justification: decision.justification || row.classification_reason,
    reasonCodes: decision.reason_codes || normalized.reason_codes || [],
    recommendedAction: decision.recommended_action || normalized.recommended_action || null,
    reviewStatus: decision.review_status || normalized.review_status || null,
    duplicateSignature: row.duplicate_signature,
    correlationId: row.correlation_id,
    receivedAt: row.received_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: normalized.resolved_at || jira.resolution_date || null,
    closedAt: normalized.closed_at || null,
    occurrences: row.occurrences,
    owner: row.owner,
    responderTeam: visibleToCommandCenter ? COMMAND_CENTER_TEAM : responderTeam,
    responder: visibleToCommandCenter ? COMMAND_CENTER_TEAM : responder,
    team: visibleToCommandCenter ? COMMAND_CENTER_TEAM : team,
    assignedTeam: visibleToCommandCenter ? COMMAND_CENTER_TEAM : normalized.assigned_team || null,
    assignee: getDisplayName(normalized.assignee || jira.assignee),
    reporter: getDisplayName(normalized.reporter || jira.reporter),
    labels: normalized.labels || jira.labels || [],
    tags: normalized.tags || [],
    signal: row.signal,
    description: row.description,
    jiraTicketId: row.jira_ticket_id,
    jiraIssueKey: normalized.jira_issue_key || jira.issue_key || row.jira_ticket_id,
    jiraUrl,
    originalJiraUrl,
    canonicalJiraUrl,
    jiraSummary: slackEnrichment.jira_summary || normalized.jira_summary || extractedAlert.jira_summary || jira.summary || null,
    jiraIssueStatus: slackEnrichment.jira_status || normalized.jira_status || extractedAlert.jira_status || jira.status || null,
    issueType: jira.issue_type || null,
    recurringIncident: row.recurring_incident,
    relatedAlerts: row.related_alerts || [],
    incidentHistory: includeDetails ? details.incident_history || [] : [],
    auditEvents: includeDetails ? row.audit_events || [] : [],
    notes: includeDetails ? row.notes || [] : [],
    linkedIssues: includeDetails ? jira.linked_issues || [] : [],
    parentIssue: includeDetails ? jira.parent_issue || null : null,
    subTasks: includeDetails ? jira.sub_tasks || [] : [],
    isActionable: !classificationLegacy && classification.isActionable,
  };
}

function getSlackUserIdFromValue(value) {
  return slackUserService.normalizeSlackUserId(value) || null;
}

function getResponderSlackUserId(responder = {}) {
  if (!responder || typeof responder !== 'object') {
    return getSlackUserIdFromValue(responder);
  }

  return getSlackUserIdFromValue(
    responder.slackUserId
    || responder.slack_user_id
    || responder.responderUserId
    || responder.responder_user_id
    || responder.id
    || responder.name
    || responder.displayName
  );
}

async function enrichAlertSlackUsers(alert) {
  if (!alert) {
    return alert;
  }

  const acknowledgedByUserId = alert.acknowledgedByUserId
    || getSlackUserIdFromValue(alert.acknowledgedBy)
    || getResponderSlackUserId((alert.responders || []).find((responder) => (
      String(responder?.role || '').toLowerCase().includes('acknowledger')
    )));
  const assigneeUserId = alert.slackAssigneeUserId
    || getSlackUserIdFromValue(alert.slackAssignee)
    || getResponderSlackUserId((alert.responders || []).find((responder) => (
      String(responder?.role || '').toLowerCase().includes('assignee')
    )));
  const resolvedResponders = await slackUserService.resolveResponders(alert.responders || []);
  const acknowledgedByName = acknowledgedByUserId
    ? await slackUserService.resolveSlackUserName(acknowledgedByUserId)
    : alert.acknowledgedByName || alert.acknowledgedBy;
  const assigneeName = assigneeUserId
    ? await slackUserService.resolveSlackUserName(assigneeUserId)
    : alert.slackAssigneeName || alert.slackAssignee;

  return {
    ...alert,
    acknowledgedBy: acknowledgedByName || alert.acknowledgedBy,
    acknowledgedByRaw: alert.acknowledgedByRaw || alert.acknowledgedBy,
    acknowledgedByUserId: acknowledgedByUserId || null,
    acknowledgedByName: acknowledgedByName || null,
    acknowledged_by_user_id: acknowledgedByUserId || null,
    acknowledged_by_name: acknowledgedByName || null,
    slackAcknowledgedBy: acknowledgedByName || alert.slackAcknowledgedBy,
    slackAcknowledgedByUserId: acknowledgedByUserId || null,
    slackAcknowledgedByName: acknowledgedByName || null,
    slack_acknowledged_by_user_id: acknowledgedByUserId || null,
    slack_acknowledged_by_name: acknowledgedByName || null,
    slackAssignee: assigneeName || alert.slackAssignee,
    slackAssigneeUserId: assigneeUserId || null,
    slackAssigneeName: assigneeName || null,
    slack_assignee_user_id: assigneeUserId || null,
    slack_assignee_name: assigneeName || null,
    assignee_user_id: assigneeUserId || alert.assignee_user_id || null,
    assignee_name: assigneeName || alert.assignee_name || null,
    responders: resolvedResponders,
  };
}

async function enrichAlertsSlackUsers(alerts = []) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return [];
  }

  return Promise.all(alerts.map((alert) => enrichAlertSlackUsers(alert)));
}

function mapIncidentRow(row) {
  return {
    id: row.incident_id,
    alertId: row.id,
    title: row.title,
    service: row.service,
    environment: row.environment,
    severity: row.severity,
    status: classificationService.deriveIncidentState(row),
    recurringIncident: row.recurring_incident,
    jiraTicketId: row.jira_ticket_id,
    owner: row.owner,
    receivedAt: row.received_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.incident_created_at,
  };
}

function displayNameFromJson(value) {
  return getDisplayName(value) || null;
}

function mapOperationsIncidentRow(row, options = {}) {
  const includeDetails = options.includeDetails !== false;

  return {
    id: row.incident_key,
    incidentKey: row.incident_key,
    alertId: Array.isArray(row.linked_alerts) ? row.linked_alerts[0] : null,
    title: row.summary || row.incident_key,
    service: 'JSM Operations',
    environment: 'unknown',
    severity: String(row.priority || '').toLowerCase().includes('high') ? 'high' : 'medium',
    priority: row.priority,
    status: row.status || 'unknown',
    resolution: row.resolution,
    recurringIncident: false,
    jiraTicketId: row.incident_key,
    sourceUrl: row.source_url,
    owner: displayNameFromJson(row.assignee) || 'Unassigned',
    assignee: displayNameFromJson(row.assignee),
    reporter: displayNameFromJson(row.reporter),
    labels: row.labels || [],
    linkedAlerts: row.linked_alerts || [],
    rootCauseNotes: includeDetails ? row.root_cause_notes || [] : [],
    comments: includeDetails ? row.comments || [] : [],
    attachments: includeDetails ? row.attachments || [] : [],
    customFields: includeDetails ? row.custom_fields || {} : {},
    incidentDetails: includeDetails ? row.incident_details || null : null,
    rawPayload: includeDetails ? row.raw_payload : null,
    receivedAt: row.incident_created_at,
    lastSeenAt: row.incident_updated_at || row.incident_created_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

function selectAlertSql(whereClause = '', options = {}) {
  const includeDetails = options.includeDetails !== false;
  const extractedDetailsSelect = includeDetails
    ? 'extracted_details'
    : `jsonb_build_object(
        'normalized_alert', jsonb_build_object(
          'priority', extracted_details->'normalized_alert'->>'priority',
          'source_name', extracted_details->'normalized_alert'->>'source_name',
          'source_tool', extracted_details->'normalized_alert'->>'source_tool',
          'monitoring_tool', extracted_details->'normalized_alert'->>'monitoring_tool',
          'monitoring_event_url', extracted_details->'normalized_alert'->>'monitoring_event_url',
          'state', extracted_details->'normalized_alert'->>'state',
          'jira_issue_key', extracted_details->'normalized_alert'->>'jira_issue_key',
          'jira_incident_key', extracted_details->'normalized_alert'->>'jira_incident_key',
          'jira_url', extracted_details->'normalized_alert'->>'jira_url',
          'jira_summary', extracted_details->'normalized_alert'->>'jira_summary',
          'jira_status', extracted_details->'normalized_alert'->>'jira_status',
          'event_link', extracted_details->'normalized_alert'->>'event_link',
          'deep_event_link', extracted_details->'normalized_alert'->>'deep_event_link',
          'recommended_action', extracted_details->'normalized_alert'->>'recommended_action',
          'review_status', extracted_details->'normalized_alert'->>'review_status'
        ),
        'slack_enrichment', jsonb_build_object(
          'monitoring_tool', extracted_details->'slack_enrichment'->>'monitoring_tool',
          'monitoring_event_url', extracted_details->'slack_enrichment'->>'monitoring_event_url',
          'jira_key', extracted_details->'slack_enrichment'->>'jira_key',
          'jira_url', extracted_details->'slack_enrichment'->>'jira_url',
          'jira_summary', extracted_details->'slack_enrichment'->>'jira_summary',
          'jira_status', extracted_details->'slack_enrichment'->>'jira_status'
        ),
        'jira', jsonb_build_object(
          'priority', extracted_details->'jira'->>'priority',
          'status', extracted_details->'jira'->>'status',
          'status_category', extracted_details->'jira'->>'status_category',
          'issue_key', extracted_details->'jira'->>'issue_key',
          'jira_url', extracted_details->'jira'->>'jira_url',
          'issue_url', extracted_details->'jira'->>'issue_url',
          'event_link', extracted_details->'jira'->>'event_link',
          'summary', extracted_details->'jira'->>'summary',
          'issue_type', extracted_details->'jira'->>'issue_type',
          'resolution_date', extracted_details->'jira'->>'resolution_date'
        ),
        'classification', extracted_details->'classification',
        'structured_alert', jsonb_build_object(
          'alias', extracted_details->'structured_alert'->>'alias',
          'entity', extracted_details->'structured_alert'->>'entity'
        )
      ) AS extracted_details`;
  const auditEventsSelect = includeDetails
    ? `COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', audit_events.id,
            'eventType', audit_events.event_type,
            'actor', audit_events.actor,
            'source', audit_events.source,
            'details', audit_events.details,
            'createdAt', audit_events.created_at
          )
          ORDER BY audit_events.created_at DESC
        )
        FROM audit_events
        WHERE audit_events.alert_id = alerts.id
      ), '[]'::jsonb) AS audit_events`
    : `'[]'::jsonb AS audit_events`;
  const notesSelect = includeDetails
    ? `COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', alert_notes.id,
            'note', alert_notes.note,
            'createdBy', alert_notes.created_by,
            'createdAt', alert_notes.created_at
          )
          ORDER BY alert_notes.created_at DESC
        )
        FROM alert_notes
        WHERE alert_notes.alert_id = alerts.id
      ), '[]'::jsonb) AS notes`
    : `'[]'::jsonb AS notes`;

  return `
    SELECT
      id,
      title,
      service,
      environment,
      severity,
      status,
      classification,
      classification_is_legacy,
      noise_type,
      confidence_score,
      source,
      source_type,
      source_alert_id,
      source_url,
      slack_channel_id,
      slack_message_ts,
      acknowledged,
      acknowledged_by,
      acknowledged_at,
      acknowledgement_source,
      escalation_status,
      escalated_at,
      escalation_reason,
      responders,
      ${includeDetails ? 'raw_payload' : 'NULL::jsonb AS raw_payload'},
      ${extractedDetailsSelect},
      ${auditEventsSelect},
      ${notesSelect},
      noise_reason,
      classification_reason,
      duplicate_signature,
      correlation_id,
      received_at,
      last_seen_at,
      occurrences,
      owner,
      signal,
      description,
      jira_ticket_id,
      recurring_incident,
      related_alerts,
      ${commandCenterAlertProjectionSql('alerts')}
    FROM alerts
    ${whereClause}
  `;
}

async function recordClassification(client, alert, classifiedBy = 'system') {
  await client.query(
    `
      INSERT INTO alert_classification_history (
        alert_id,
        classification,
        noise_type,
        confidence_score,
        justification,
        noise_reason,
        classified_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      alert.id,
      alert.classification,
      alert.noise_type,
      alert.confidence_score,
      alert.classification_reason || 'Classification reason was not provided.',
      alert.noise_reason,
      classifiedBy,
    ],
  );
}

async function recordCorrelation(client, alert) {
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
      Number(alert.occurrences || 1),
      JSON.stringify(alert.related_alerts || []),
    ],
  );
}

async function recordAuditEvent(client, alertId, eventType, actor, source, details = {}) {
  await client.query(
    `
      INSERT INTO audit_events (alert_id, event_type, actor, source, details)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [alertId, eventType, actor || null, source || 'backend', JSON.stringify(details || {})],
  );
}

function requiresAcknowledgement(row) {
  const sourceType = String(row.source_type || '').toLowerCase();
  const source = String(row.source || '').toLowerCase();

  return Boolean(row.slack_channel_id)
    || sourceType === 'slack'
    || sourceType.includes('slack')
    || source.includes('slack');
}

function assertInvestigationAllowed(row) {
  if (requiresAcknowledgement(row) && !row.acknowledged) {
    const error = new Error('This Slack-notified alert must be acknowledged before investigation or classification can start.');
    error.status = 409;
    throw error;
  }
}

function increaseSeverityForEscalation(severity) {
  const normalized = String(severity || '').toLowerCase();

  if (normalized === 'critical') return 'critical';
  if (normalized === 'high') return 'critical';
  if (normalized === 'medium' || normalized === 'warning') return 'high';
  if (normalized === 'low') return 'medium';

  return 'high';
}

function buildClassificationReasonWithWorkflow(row, classified) {
  return [
    classified.classificationReason,
    row.acknowledged
      ? `Acknowledged by ${row.acknowledged_by || 'operator'} via ${row.acknowledgement_source || 'unknown source'}.`
      : 'Not acknowledged yet.',
    row.escalation_status
      ? `Escalated because ${row.escalation_reason || 'acknowledgement was not received in time'}.`
      : 'Not escalated before classification.',
    `Source: ${row.source || 'unknown'}.`,
    row.jira_ticket_id
      ? `Linked Jira incident: ${row.jira_ticket_id}.`
      : 'No Jira incident linked yet.',
    classified.classification === 'incident'
      ? 'Recommended next step: investigate in the website and continue incident workflow.'
      : classified.classification === 'noise'
        ? 'Recommended next step: suppress, group, or monitor without incident creation.'
        : 'Recommended next step: route to operator review.',
  ].filter(Boolean).join(' ');
}

async function getMappedAlertById(id, options = {}) {
  const result = await db.query(selectAlertSql('WHERE id = $1', options), [id]);

  return result.rows[0] ? enrichAlertSlackUsers(mapAlertRow(result.rows[0], options)) : null;
}

async function acknowledgeAlert(id, options = {}) {
  await ensureAlertOptionalColumns();
  const client = await db.pool.connect();
  const acknowledgedBy = options.acknowledgedBy || options.slackUserId || 'Slack user';
  const acknowledgementSource = options.source || 'slack';

  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `
        UPDATE alerts
        SET
          acknowledged = true,
          acknowledged_by = $2,
          acknowledged_at = COALESCE(acknowledged_at, NOW()),
          acknowledgement_source = $3,
          status = CASE
            WHEN status IN ('resolved', 'recovered', 'auto-resolved', 'closed') THEN status
            ELSE 'acknowledged'
          END,
          updated_at = NOW()
        WHERE id = $1
      `,
      [id, acknowledgedBy, acknowledgementSource],
    );

    await client.query(
      `
        INSERT INTO alert_acknowledgements (
          alert_id,
          acknowledged_by,
          slack_user_id,
          acknowledgement_source
        )
        VALUES ($1, $2, $3, $4)
      `,
      [id, acknowledgedBy, options.slackUserId || null, acknowledgementSource],
    );

    await client.query(
      `
        UPDATE slack_notifications
        SET acknowledged_at = COALESCE(acknowledged_at, NOW()),
            status = 'acknowledged'
        WHERE alert_id = $1
      `,
      [id],
    );

    await recordAuditEvent(client, id, 'alert_acknowledged', acknowledgedBy, acknowledgementSource, {
      action: 'acknowledge',
      alertSource: currentAlert.source,
      acknowledgedBy,
      acknowledgementSource,
      result: 'success',
      slackUserId: options.slackUserId || null,
      previousStatus: currentAlert.status,
    });

    await client.query('COMMIT');

    return getMappedAlertById(id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addAlertNote(id, options = {}) {
  await ensureAlertOptionalColumns();
  const note = String(options.note || '').trim();
  const createdBy = options.createdBy || 'Website operator';

  if (!note) {
    const error = new Error('Note cannot be empty.');
    error.status = 400;
    throw error;
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    assertInvestigationAllowed(currentAlert);

    await client.query(
      `
        INSERT INTO alert_notes (alert_id, note, created_by)
        VALUES ($1, $2, $3)
      `,
      [id, note, createdBy],
    );

    await client.query('UPDATE alerts SET updated_at = NOW() WHERE id = $1', [id]);
    await recordAuditEvent(client, id, 'note_added', createdBy, 'website', {
      action: 'note',
      alertSource: currentAlert.source,
      note,
      result: 'success',
    });

    await client.query('COMMIT');

    return getMappedAlertById(id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function getFirstValue(values = []) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '') || null;
}

function normalizeOpsAlertId(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  const numberMatch = text.match(/#?(\d{3,})/);

  return numberMatch ? numberMatch[1] : text;
}

function resolveJsmOpsAlertId(alert, options = {}) {
  const details = alert.extracted_details || {};
  const candidates = [
    options.opsAlertId,
    options.jsmOpsAlertId,
    options.atlassianAlertId,
    details.jsm_ops?.alert_id,
    details.ops_alert?.id,
    details.normalized_alert?.ops_alert_id,
    details.normalized_alert?.alert_id,
    details.alert?.ops_alert_id,
    details.alert?.source_alert_id,
    details.alert?.alert_number,
    ...(Array.isArray(alert.related_alerts) ? alert.related_alerts : []),
    alert.title,
    alert.source_alert_id && !String(alert.source_alert_id).includes(':') ? alert.source_alert_id : null,
  ];

  return normalizeOpsAlertId(getFirstValue(candidates));
}

function mergeResponders(existing = [], responders = [], metadata = {}) {
  const current = Array.isArray(existing) ? existing : [];
  const assignedAt = metadata.assignedAt || new Date().toISOString();
  const source = metadata.source || 'jsm_ops';
  const incoming = responders.map((responder) => ({
    ...responder,
    assignedAt: responder.assignedAt || responder.acknowledgedAt || assignedAt,
    assignmentStatus: metadata.status || 'assigned',
    source: responder.source || source,
  }));
  const merged = [...current];

  incoming.forEach((responder) => {
    const key = String(
      responder.slackUserId
      || responder.slack_user_id
      || responder.id
      || responder.accountId
      || responder.name
      || responder.displayName
      || ''
    ).toLowerCase();
    const index = merged.findIndex((item) => (
      String(
        item.slackUserId
        || item.slack_user_id
        || item.id
        || item.accountId
        || item.name
        || item.displayName
        || ''
      ).toLowerCase() === key
    ));

    if (key && index >= 0) {
      merged[index] = {
        ...merged[index],
        ...responder,
      };
      return;
    }

    merged.push(responder);
  });

  return merged;
}

function parseSlackUserMap() {
  const value = process.env.SLACK_USER_MAP;

  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall through to the simple comma-separated parser below.
  }

  return String(value)
    .split(',')
    .map((entry) => entry.split('='))
    .reduce((mapping, [key, name]) => {
      const normalizedKey = String(key || '').trim();
      const normalizedName = String(name || '').trim();

      if (normalizedKey && normalizedName) {
        mapping[normalizedKey] = normalizedName;
      }

      return mapping;
    }, {});
}

function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{4,}$/i.test(String(value || '').trim());
}

function resolveSlackDisplayName(value, slackUserId = null) {
  const userMap = parseSlackUserMap();
  const id = slackUserId || (isSlackUserId(value) ? value : null);
  const mappedName = id ? userMap[id] : null;
  const fallback = String(value || '').replace(/^@+/, '').trim();

  return mappedName || fallback || null;
}

function normalizeSlackResponder(responder, defaults = {}) {
  if (!responder) {
    return null;
  }

  const value = typeof responder === 'string'
    ? { name: responder }
    : responder;
  const possibleId = value.slackUserId
    || value.slack_user_id
    || (isSlackUserId(value.id) ? value.id : null)
    || (isSlackUserId(value.name) ? value.name : null)
    || (isSlackUserId(value.displayName) ? value.displayName : null);
  const rawName = value.displayName || value.name || value.id || possibleId || null;
  const displayName = resolveSlackDisplayName(rawName, possibleId);

  if (!possibleId && !displayName) {
    return null;
  }

  return {
    id: possibleId || value.id || displayName,
    slackUserId: possibleId || null,
    name: displayName || rawName || possibleId,
    displayName: displayName || null,
    role: value.role || defaults.role || 'responder',
    source: value.source || defaults.source || 'slack_message',
    acknowledgedAt: value.acknowledgedAt || defaults.acknowledgedAt || null,
    needsNameMapping: Boolean(possibleId && (!displayName || displayName === possibleId)),
  };
}

function buildSlackResponders(parsedAlert, acknowledgement = {}) {
  const responders = [];

  (parsedAlert.slackResponders || []).forEach((responder) => {
    const normalized = normalizeSlackResponder(responder, {
      source: responder.source || 'slack_message',
      acknowledgedAt: acknowledgement.acknowledgedAt,
    });

    if (normalized) {
      responders.push(normalized);
    }
  });

  const assignee = normalizeSlackResponder(parsedAlert.slackAssignee, {
    role: 'assignee',
    source: 'slack_assignee',
  });

  if (assignee) {
    responders.push(assignee);
  }

  if (acknowledgement.acknowledgedBy || acknowledgement.slackUserId) {
    const acknowledger = normalizeSlackResponder({
      id: acknowledgement.slackUserId || acknowledgement.acknowledgedBy,
      slackUserId: acknowledgement.slackUserId,
      name: acknowledgement.acknowledgedBy,
      displayName: acknowledgement.acknowledgedBy,
      role: 'acknowledger',
      source: 'slack_acknowledgement',
      acknowledgedAt: acknowledgement.acknowledgedAt,
    });

    if (acknowledger) {
      responders.push(acknowledger);
    }
  }

  return mergeResponders([], responders, {
    source: 'slack_message',
    status: acknowledgement.acknowledged ? 'acknowledged' : 'detected',
    assignedAt: acknowledgement.acknowledgedAt,
  });
}

async function addAlertResponder(id, options = {}) {
  await ensureAlertOptionalColumns();
  const actor = options.assignedBy || 'Website operator';
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    assertInvestigationAllowed(currentAlert);

    const opsAlertId = resolveJsmOpsAlertId(currentAlert, options);

    if (!opsAlertId) {
      const error = new Error('Unable to find a Jira Service Management Operations alert id for this alert. Provide opsAlertId in the request body.');
      error.status = 400;
      throw error;
    }

    const jsmResponse = await jsmOpsService.addAlertResponder(opsAlertId, {
      responders: options.responders || options.responder,
    });
    const existingDetails = currentAlert.extracted_details || {};
    const updatedResponders = mergeResponders(currentAlert.responders, jsmResponse.responders, {
      status: jsmResponse.status,
    });
    const updatedDetails = {
      ...existingDetails,
      jsm_ops: {
        ...(existingDetails.jsm_ops || {}),
        alert_id: opsAlertId,
        last_responder_assignment: {
          assigned_by: actor,
          assigned_at: new Date().toISOString(),
          responders: jsmResponse.responders,
          status: jsmResponse.status,
          metadata: jsmResponse.metadata,
        },
        responders: updatedResponders,
      },
    };

    await client.query(
      `
        UPDATE alerts
        SET responders = $2::jsonb,
            extracted_details = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, JSON.stringify(updatedResponders), JSON.stringify(updatedDetails)],
    );

    await recordAuditEvent(client, id, 'jsm_ops_responder_assigned', actor, 'website', {
      opsAlertId,
      responders: jsmResponse.responders,
      status: jsmResponse.status,
      metadata: jsmResponse.metadata,
    });

    await client.query('COMMIT');

    const alert = await getMappedAlertById(id);

    return {
      alert,
      alertId: id,
      jiraOpsStatus: jsmResponse.status,
      metadata: jsmResponse.metadata,
      opsAlertId,
      responderAdded: jsmResponse.responders,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function linkJiraIncident(id, options = {}) {
  await ensureAlertOptionalColumns();
  const jiraTicketId = String(options.jiraTicketId || '').trim().toUpperCase();
  const linkedBy = options.linkedBy || 'Website operator';

  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(jiraTicketId)) {
    const error = new Error('Enter a valid Jira issue key, for example ACC-1234.');
    error.status = 400;
    throw error;
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    assertInvestigationAllowed(currentAlert);

    let jiraIssue = null;
    let jiraLookupError = null;

    try {
      jiraIssue = await jiraService.getIssueDetails(jiraTicketId);
    } catch (error) {
      jiraLookupError = error.message;
    }

    const details = currentAlert.extracted_details || {};
    const existingNormalized = details.normalized_alert || {};
    const nextDeepEventLink = jiraIssue?.deep_event_link
      || existingNormalized.deep_event_link
      || currentAlert.source_url
      || null;
    const nextDetails = {
      ...details,
      normalized_alert: {
        ...existingNormalized,
        jira_issue_key: jiraTicketId,
        jira_incident_key: jiraTicketId,
        deep_event_link: nextDeepEventLink,
        event_link: jiraIssue?.event_link || existingNormalized.event_link || currentAlert.source_url || null,
        source_tool: existingNormalized.source_tool || jiraIssue?.source_tool || currentAlert.source,
      },
      jira: jiraIssue || {
        ...(details.jira || {}),
        issue_key: jiraTicketId,
        enrichment_error: jiraLookupError,
      },
    };

    const updatedResult = await client.query(
      `
        UPDATE alerts
        SET
          jira_ticket_id = $2,
          extracted_details = $3::jsonb,
          source_url = COALESCE(source_url, $4),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id, jiraTicketId, JSON.stringify(nextDetails), nextDeepEventLink],
    );
    const updatedAlert = updatedResult.rows[0];

    if (updatedAlert.classification === 'incident') {
      await syncIncidentForAlert(client, updatedAlert);
    }

    await recordAuditEvent(client, id, 'jira_incident_linked', linkedBy, 'website', {
      jiraTicketId,
      jiraLookupStatus: jiraIssue ? 'enriched' : 'linked_without_enrichment',
      jiraLookupError,
    });

    await client.query('COMMIT');

    return getMappedAlertById(id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function escalateAlert(id, options = {}) {
  await ensureAlertOptionalColumns();
  const client = await db.pool.connect();
  const reason = options.reason || 'Alert was not acknowledged within 2 minutes.';
  const actor = options.actor || 'system';
  const source = options.source || 'backend';

  try {
    await client.query('BEGIN');

    const currentResult = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    const previousSeverity = currentAlert.severity;
    const newSeverity = increaseSeverityForEscalation(currentAlert.severity);

    await client.query(
      `
        UPDATE alerts
        SET
          escalation_status = true,
          escalated_at = COALESCE(escalated_at, NOW()),
          escalation_reason = $2,
          severity = $3,
          status = CASE
            WHEN status IN ('resolved', 'recovered', 'auto-resolved', 'closed') THEN status
            ELSE 'escalated'
          END,
          updated_at = NOW()
        WHERE id = $1
      `,
      [id, reason, newSeverity],
    );

    await client.query(
      `
        INSERT INTO alert_escalations (
          alert_id,
          escalation_reason,
          previous_severity,
          new_severity,
          responder_team
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [id, reason, previousSeverity, newSeverity, options.responderTeam || currentAlert.owner || null],
    );

    await recordAuditEvent(client, id, 'alert_escalated', actor, source, {
      reason,
      previousSeverity,
      newSeverity,
      responderTeam: options.responderTeam || currentAlert.owner || null,
    });

    await client.query('COMMIT');

    return getMappedAlertById(id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function escalateExpiredAlerts() {
  await ensureAlertOptionalColumns();
  const dueResult = await db.query(
    `
      SELECT id
      FROM alerts
      WHERE acknowledged = false
        AND escalation_status = false
        AND (
          slack_channel_id IS NOT NULL
          OR LOWER(COALESCE(source_type, '')) LIKE '%slack%'
          OR LOWER(COALESCE(source, '')) LIKE '%slack%'
        )
        AND received_at <= NOW() - INTERVAL '2 minutes'
        AND status NOT IN ('resolved', 'recovered', 'auto-resolved', 'closed')
      ORDER BY received_at ASC
      LIMIT 50
    `,
  );
  const escalated = [];

  for (const row of dueResult.rows) {
    escalated.push(await escalateAlert(row.id, {
      actor: 'system',
      source: 'auto-escalation',
      reason: 'Slack acknowledgement was not received within 2 minutes.',
    }));
  }

  return escalated.filter(Boolean);
}

function buildAlertFilters(filters = {}) {
  const clauses = [commandCenterAlertSql('alerts')];
  const params = [];

  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }

  if (filters.priority && filters.priority !== 'all') {
    const param = addParam(String(filters.priority).toLowerCase());
    clauses.push(`LOWER(COALESCE(extracted_details->'normalized_alert'->>'priority', extracted_details->'jira'->>'priority', '')) = ${param}`);
  }

  if (filters.urgency && filters.urgency !== 'all') {
    const param = addParam(String(filters.urgency).toLowerCase());
    clauses.push(`LOWER(COALESCE(extracted_details->'structured_alert'->>'urgency', extracted_details->'jira'->>'urgency', '')) = ${param}`);
  }

  if (filters.severity && filters.severity !== 'all') {
    const param = addParam(String(filters.severity).toLowerCase());
    clauses.push('LOWER(COALESCE(severity, \'\')) = ' + param);
  }

  if (filters.environment && filters.environment !== 'all') {
    const param = addParam(String(filters.environment).toLowerCase());
    clauses.push('LOWER(COALESCE(environment, \'\')) = ' + param);
  }

  if (filters.status && filters.status !== 'all') {
    const param = addParam(String(filters.status).toLowerCase());
    clauses.push(`(
      LOWER(COALESCE(status, '')) = ${param}
      OR LOWER(COALESCE(extracted_details->'jira'->>'status', '')) = ${param}
    )`);
  }

  if (filters.sourceTool && filters.sourceTool !== 'all') {
    const param = addParam(String(filters.sourceTool).toLowerCase());
    clauses.push(`LOWER(COALESCE(source, extracted_details->'normalized_alert'->>'source_tool', '')) = ${param}`);
  }

  if (filters.source && filters.source !== 'all') {
    const param = addParam(String(filters.source).toLowerCase());
    clauses.push(`(
      LOWER(COALESCE(source, extracted_details->'normalized_alert'->>'source_tool', '')) = ${param}
      OR LOWER(COALESCE(extracted_details->'normalized_alert'->>'monitoring_tool', '')) = ${param}
      OR LOWER(COALESCE(extracted_details->'normalized_alert'->>'source_name', '')) = ${param}
    )`);
  }

  if (filters.classification && filters.classification !== 'all') {
    const param = addParam(String(filters.classification).toLowerCase());
    clauses.push(`LOWER(classification) = ${param}`);
  }

  if (filters.service && filters.service !== 'all') {
    const param = addParam(String(filters.service).toLowerCase());
    clauses.push('LOWER(COALESCE(service, \'\')) = ' + param);
  }

  if (filters.acknowledged && filters.acknowledged !== 'all') {
    const value = String(filters.acknowledged).toLowerCase();

    if (['true', 'acknowledged', 'yes'].includes(value)) {
      clauses.push('acknowledged = true');
    } else if (['false', 'unacknowledged', 'no'].includes(value)) {
      clauses.push('acknowledged = false');
    }
  }

  if (filters.createdFrom) {
    const param = addParam(filters.createdFrom);
    clauses.push(`received_at >= ${param}::timestamptz`);
  }

  if (filters.createdTo) {
    const param = addParam(filters.createdTo);
    clauses.push(`received_at <= ${param}::timestamptz`);
  }

  if (filters.updatedFrom) {
    const param = addParam(filters.updatedFrom);
    clauses.push(`COALESCE(last_seen_at, received_at, created_at) >= ${param}::timestamptz`);
  }

  if (filters.updatedTo) {
    const param = addParam(filters.updatedTo);
    clauses.push(`COALESCE(last_seen_at, received_at, created_at) <= ${param}::timestamptz`);
  }

  if (filters.assignee && filters.assignee !== 'all') {
    const param = addParam(`%${String(filters.assignee).toLowerCase()}%`);
    clauses.push(`(
      LOWER(COALESCE(owner, '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'structured_alert'->'people'->>'assignee', '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'normalized_alert'->'assignee'->>'displayName', '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'jira'->'assignee'->>'displayName', '')) LIKE ${param}
    )`);
  }

  if (filters.team && filters.team !== 'all') {
    const param = addParam(String(filters.team).trim().toLowerCase());
    clauses.push(`${param} = 'command center'`);
  }

  if (filters.search) {
    const param = addParam(`%${String(filters.search).toLowerCase()}%`);
    clauses.push(`(
      LOWER(COALESCE(id, '')) LIKE ${param}
      OR LOWER(COALESCE(title, '')) LIKE ${param}
      OR LOWER(COALESCE(service, '')) LIKE ${param}
      OR LOWER(COALESCE(owner, '')) LIKE ${param}
      OR LOWER(COALESCE(signal, '')) LIKE ${param}
      OR LOWER(COALESCE(description, '')) LIKE ${param}
      OR LOWER(COALESCE(jira_ticket_id, '')) LIKE ${param}
      OR LOWER(COALESCE(source_alert_id, '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'structured_alert'->>'alias', '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'structured_alert'->>'entity', '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'jira'->>'issue_key', '')) LIKE ${param}
      OR LOWER(COALESCE(extracted_details->'normalized_alert'->>'jira_incident_key', '')) LIKE ${param}
    )`);
  }

  if (filters.state && filters.state !== 'all') {
    const state = String(filters.state).toLowerCase();

    if (state === 'closed') {
      clauses.push(`(
        COALESCE(extracted_details->'normalized_alert'->>'state', '') = 'closed'
        OR LOWER(COALESCE(extracted_details->'jira'->>'status_category', '')) = 'done'
        OR extracted_details->'jira'->>'resolution_date' IS NOT NULL
        OR status IN ('resolved', 'recovered', 'auto-resolved')
      )`);
    }

    if (state === 'open') {
      clauses.push(`NOT (
        COALESCE(extracted_details->'normalized_alert'->>'state', '') = 'closed'
        OR LOWER(COALESCE(extracted_details->'jira'->>'status_category', '')) = 'done'
        OR extracted_details->'jira'->>'resolution_date' IS NOT NULL
        OR status IN ('resolved', 'recovered', 'auto-resolved')
      )`);
    }
  }

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateInput(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return Number.isNaN(parsed.getTime()) ? null : String(value);
}

function sqlTimestampFromText(expression) {
  return `CASE WHEN ${expression} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (${expression})::timestamptz END`;
}

const alertEventTimestampSql = `
  COALESCE(
    ${sqlTimestampFromText("alerts.extracted_details->'normalized_alert'->>'created_at'")},
    ${sqlTimestampFromText("alerts.extracted_details->'normalized_alert'->>'timestamp'")},
    ${sqlTimestampFromText("alerts.extracted_details->'structured_alert'->'timings'->>'created_at'")},
    ${sqlTimestampFromText("alerts.raw_payload->>'createdAt'")},
    ${sqlTimestampFromText("alerts.raw_payload->>'created_at'")},
    ${sqlTimestampFromText("alerts.raw_payload->>'startsAt'")},
    ${sqlTimestampFromText("alerts.raw_payload->>'startTime'")},
    ${sqlTimestampFromText("alerts.raw_payload->>'firstSeen'")},
    ${sqlTimestampFromText("alerts.raw_payload->>'timestamp'")},
    alerts.received_at,
    alerts.last_seen_at,
    alerts.created_at
  )
`;

function resolveTrendDateRange(options = {}) {
  const range = options.range || '30d';
  const today = new Date();
  let startDate = null;
  let endDate = formatDateInput(today);

  if (range === 'custom') {
    startDate = parseDateInput(options.from);
    endDate = parseDateInput(options.to) || endDate;

    if (!startDate) {
      const fallbackStart = new Date(today);
      fallbackStart.setUTCDate(fallbackStart.getUTCDate() - 29);
      startDate = formatDateInput(fallbackStart);
    }

    return {
      range,
      startDate,
      endDate,
    };
  }

  const daysByRange = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
  };
  const days = daysByRange[range] || 30;
  const start = new Date(today);

  start.setUTCDate(start.getUTCDate() - (days - 1));
  startDate = formatDateInput(start);

  return {
    range: daysByRange[range] ? range : '30d',
    startDate,
    endDate,
  };
}

async function getAlertTrend(options = {}) {
  await ensureAlertOptionalColumns();
  let { range, startDate, endDate } = resolveTrendDateRange(options);
  const timezone = options.timezone || process.env.TZ || 'UTC';

  if (options.range === 'all') {
    const boundsResult = await db.query(
      `
        WITH alert_events AS (
          SELECT ${alertEventTimestampSql} AS event_time
          FROM alerts
          WHERE alerts.classification IN ('incident', 'noise')
            AND ${commandCenterAlertSql('alerts')}
        )
        SELECT
          to_char(MIN((event_time AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS start_date,
          to_char(MAX((event_time AT TIME ZONE $1)::date), 'YYYY-MM-DD') AS end_date
        FROM alert_events
      `,
      [timezone],
    );
    const bounds = boundsResult.rows[0];

    if (bounds?.start_date && bounds?.end_date) {
      range = 'all';
      startDate = bounds.start_date;
      endDate = bounds.end_date;
    }
  }

  const result = await db.query(
    `
      WITH bounds AS (
        SELECT $1::date AS start_date, $2::date AS end_date
      ),
      days AS (
        SELECT generate_series(bounds.start_date, bounds.end_date, '1 day'::interval)::date AS alert_date
        FROM bounds
      ),
      alert_events AS (
        SELECT
          ${alertEventTimestampSql} AS event_time,
          alerts.classification
        FROM alerts
        WHERE alerts.classification IN ('incident', 'noise')
          AND ${commandCenterAlertSql('alerts')}
      ),
      daily AS (
        SELECT
          (alert_events.event_time AT TIME ZONE $3)::date AS alert_date,
          COUNT(*) FILTER (WHERE alert_events.classification = 'incident')::integer AS incidents,
          COUNT(*) FILTER (WHERE alert_events.classification = 'noise')::integer AS noise
        FROM alert_events, bounds
        WHERE (alert_events.event_time AT TIME ZONE $3)::date BETWEEN bounds.start_date AND bounds.end_date
        GROUP BY 1
      )
      SELECT
        to_char(days.alert_date, 'YYYY-MM-DD') AS date,
        to_char(days.alert_date, 'DD Mon YYYY') AS label,
        COALESCE(daily.incidents, 0)::integer AS incidents,
        COALESCE(daily.noise, 0)::integer AS noise,
        (COALESCE(daily.incidents, 0) + COALESCE(daily.noise, 0))::integer AS total
      FROM days
      LEFT JOIN daily ON daily.alert_date = days.alert_date
      ORDER BY days.alert_date ASC
    `,
    [startDate, endDate, timezone],
  );

  return {
    range,
    startDate,
    endDate,
    timezone,
    data: result.rows.map((row) => ({
      date: row.date,
      label: row.label,
      incidents: Number(row.incidents || 0),
      noise: Number(row.noise || 0),
      total: Number(row.total || 0),
    })),
  };
}

const sourceDashboardDefinitions = getMonitoringSourceDefinitions();

const sourceSeverityOrder = ['critical', 'high', 'medium', 'warning', 'low'];
const sourceClassificationOrder = ['incident', 'noise', 'needs_review', 'unclassified'];
const sourceClassificationColors = {
  incident: '#f43f5e',
  noise: '#06b6d4',
  needs_review: '#f59e0b',
  unclassified: '#64748b',
};

function getAlertEventTime(alert) {
  const value = alert.event_time || alert.received_at || alert.last_seen_at || alert.created_at;
  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function getAlertActivityTime(alert) {
  const value = alert.last_seen_at || alert.received_at || alert.created_at;
  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function formatTrendDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatTrendLabel(date) {
  return new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: 'short',
  }).format(date);
}

function buildSourceTrend(alerts, days = 30) {
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  start.setUTCDate(start.getUTCDate() - (days - 1));

  const grouped = new Map();

  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);

    date.setUTCDate(start.getUTCDate() + index);
    grouped.set(formatTrendDate(date), {
      date: formatTrendDate(date),
      label: formatTrendLabel(date),
      total: 0,
      incidents: 0,
      noise: 0,
    });
  }

  alerts.forEach((alert) => {
    const timestamp = getAlertEventTime(alert);

    if (!timestamp) {
      return;
    }

    const key = formatTrendDate(timestamp);
    const bucket = grouped.get(key);

    if (!bucket) {
      return;
    }

    bucket.total += 1;

    if (alert.classification === 'incident') {
      bucket.incidents += 1;
    }

    if (alert.classification === 'noise') {
      bucket.noise += 1;
    }
  });

  return [...grouped.values()];
}

function buildSourceSeverityData(alerts) {
  return sourceSeverityOrder.map((severity) => ({
    severity,
    count: alerts.filter((alert) => alert.severity === severity).length,
  }));
}

function buildSourceClassificationData(alerts) {
  return sourceClassificationOrder.map((classification) => ({
    name: classification,
    value: alerts.filter((alert) => (alert.classification || 'unclassified') === classification).length,
    color: sourceClassificationColors[classification],
  }));
}

function buildSourceTopServices(alerts) {
  const counts = alerts.reduce((result, alert) => {
    const service = alert.service || 'unknown-service';
    result[service] = (result[service] || 0) + 1;
    return result;
  }, {});

  return Object.entries(counts)
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

function getSourceLastSeen(alerts) {
  const timestamps = alerts
    .map((alert) => getAlertActivityTime(alert)?.getTime())
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function mapSourceRecentAlert(alert) {
  return {
    id: alert.id,
    title: alert.title,
    service: alert.service,
    severity: alert.severity,
    status: alert.status,
    classification: alert.classification,
    jiraTicketId: alert.jira_ticket_id,
    receivedAt: alert.received_at,
    lastSeenAt: alert.last_seen_at,
  };
}

async function getSourceDashboardSummary() {
  await ensureAlertOptionalColumns();

  const result = await db.query(`
    SELECT
      id,
      title,
      source,
      source_type,
      extracted_details->'normalized_alert'->>'source_tool' AS source_tool,
      extracted_details->'normalized_alert'->>'source_name' AS source_name,
      extracted_details->'normalized_alert'->>'source_instance' AS source_instance,
      extracted_details->'normalized_alert'->>'application' AS application,
      extracted_details->'jira'->>'monitoring_system_name' AS monitoring_system_name,
      extracted_details->'custom_properties'->>'source_tool' AS custom_source_tool,
      extracted_details->'custom_properties'->>'source_instance' AS custom_source_instance,
      service,
      severity,
      status,
      classification,
      jira_ticket_id,
      received_at,
      last_seen_at,
      created_at,
      ${alertEventTimestampSql} AS event_time
    FROM alerts
    WHERE ${commandCenterAlertSql('alerts')}
    ORDER BY COALESCE(last_seen_at, received_at, created_at) DESC
  `);
  const rows = result.rows;

  return {
    sources: sourceDashboardDefinitions.map((definition) => {
      const sourceAlerts = rows.filter((alert) => sourceMatchesDefinition(alert, definition));
      const metrics = {
        total: sourceAlerts.length,
        active: sourceAlerts.filter((alert) => ['open', 'firing', 'triggered', 'investigating'].includes(alert.status)).length,
        incidents: sourceAlerts.filter((alert) => alert.classification === 'incident').length,
        noise: sourceAlerts.filter((alert) => alert.classification === 'noise').length,
        jiraLinked: sourceAlerts.filter((alert) => alert.jira_ticket_id).length,
      };

      return {
        id: definition.id,
        label: definition.label,
        adapterName: definition.adapterName,
        category: definition.category,
        description: definition.description,
        count: sourceAlerts.length,
        lastSeen: getSourceLastSeen(sourceAlerts),
        metrics,
        trend: buildSourceTrend(sourceAlerts),
        severity: buildSourceSeverityData(sourceAlerts),
        classification: buildSourceClassificationData(sourceAlerts),
        topServices: buildSourceTopServices(sourceAlerts),
        recentAlerts: sourceAlerts.slice(0, 8).map(mapSourceRecentAlert),
      };
    }),
  };
}

async function getAlerts(filters = {}) {
  await ensureAlertOptionalColumns();
  await escalateExpiredAlerts();
  const { whereClause, params } = buildAlertFilters(filters);
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 500, 1), 1000);
  const offset = Math.max(Number.parseInt(filters.offset, 10) || 0, 0);
  const sortDirection = String(filters.sort || 'latest').toLowerCase() === 'oldest' ? 'ASC' : 'DESC';
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const result = await db.query(
    `
      ${selectAlertSql(whereClause, { includeDetails: false })}
      ORDER BY COALESCE(last_seen_at, received_at, created_at) ${sortDirection}
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    [...params, limit, offset],
  );

  return enrichAlertsSlackUsers(result.rows.map((row) => mapAlertRow(row, { includeDetails: false })));
}

async function getAlertCount(filters = {}) {
  await ensureAlertOptionalColumns();
  const { whereClause, params } = buildAlertFilters(filters);
  const result = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM alerts
      ${whereClause}
    `,
    params,
  );

  return result.rows[0]?.total || 0;
}

async function getAlertById(id) {
  await ensureAlertOptionalColumns();
  await escalateExpiredAlerts();
  let result = await db.query(
    selectAlertSql(`WHERE id = $1 AND ${commandCenterAlertSql('alerts')}`),
    [id],
  );

  if (result.rows[0] && shouldRefreshStoredSlackEnrichment(result.rows[0])) {
    await refreshStoredSlackAlertEnrichment(result.rows[0]);
    result = await db.query(
      selectAlertSql(`WHERE id = $1 AND ${commandCenterAlertSql('alerts')}`),
      [id],
    );
  }

  return result.rows[0] ? enrichAlertSlackUsers(mapAlertRow(result.rows[0])) : null;
}

async function assertCommandCenterAlertVisible(id) {
  const result = await db.query(
    `SELECT 1 FROM alerts WHERE id = $1 AND ${commandCenterAlertSql('alerts')}`,
    [id],
  );
  if (!result.rows[0]) {
    const error = new Error('The requested alert is not visible.');
    error.code = 'ALERT_NOT_VISIBLE';
    error.status = 404;
    error.safeMessage = 'The requested alert is not visible.';
    throw error;
  }
}

async function getAlertActivity(id) {
  await ensureAlertOptionalColumns();
  await assertCommandCenterAlertVisible(id);
  const result = await db.query(
    `
      SELECT *
      FROM (
        SELECT
          'activity' AS type,
          alert_activity_logs.event_type AS event_type,
          alert_activity_logs.actor AS actor,
          alert_activity_logs.message AS message,
          alert_activity_logs.activity_at AS occurred_at,
          alert_activity_logs.raw_payload AS raw_payload
        FROM alert_activity_logs
        WHERE alert_activity_logs.alert_id = $1

        UNION ALL

        SELECT
          'note' AS type,
          'note' AS event_type,
          alert_notes.created_by AS actor,
          alert_notes.note AS message,
          alert_notes.created_at AS occurred_at,
          alert_notes.raw_payload AS raw_payload
        FROM alert_notes
        WHERE alert_notes.alert_id = $1

        UNION ALL

        SELECT
          'responder' AS type,
          COALESCE(alert_responders.role, 'responder') AS event_type,
          alert_responders.responder_name AS actor,
          CONCAT('Responder ', COALESCE(alert_responders.responder_name, alert_responders.responder_external_id), ' assigned') AS message,
          alert_responders.updated_at AS occurred_at,
          alert_responders.raw_payload AS raw_payload
        FROM alert_responders
        WHERE alert_responders.alert_id = $1

        UNION ALL

        SELECT
          'attachment' AS type,
          'attachment' AS event_type,
          NULL AS actor,
          COALESCE(alert_attachments.file_name, 'Attachment metadata stored') AS message,
          alert_attachments.created_at AS occurred_at,
          alert_attachments.raw_payload AS raw_payload
        FROM alert_attachments
        WHERE alert_attachments.alert_id = $1

        UNION ALL

        SELECT
          'audit' AS type,
          audit_events.event_type AS event_type,
          audit_events.actor AS actor,
          COALESCE(audit_events.details->>'message', audit_events.event_type) AS message,
          audit_events.created_at AS occurred_at,
          audit_events.details AS raw_payload
        FROM audit_events
        WHERE audit_events.alert_id = $1
      ) AS timeline
      ORDER BY occurred_at DESC NULLS LAST
      LIMIT 200
    `,
    [id],
  );

  return result.rows.map((row) => ({
    actor: row.actor,
    eventType: row.event_type,
    message: row.message,
    occurredAt: row.occurred_at,
    rawPayload: row.raw_payload,
    type: row.type,
  }));
}

function buildSlackEventFromIngestPayload(payload = {}) {
  const source = payload.event || payload.message || payload.alert || payload;
  const alert = payload.alert || {};
  const title = source.title || source.summary || alert.title || alert.summary || payload.title || payload.summary || 'Manual ingested alert';
  const text = source.text
    || payload.text
    || [
      title,
      payload.jira_key || payload.jiraKey || alert.jira_key || alert.jiraKey ? `Jira: ${payload.jira_key || payload.jiraKey || alert.jira_key || alert.jiraKey}` : null,
      payload.service || alert.service ? `service: ${payload.service || alert.service}` : null,
      payload.environment || alert.environment ? `environment: ${payload.environment || alert.environment}` : null,
      payload.severity || alert.severity ? `severity: ${payload.severity || alert.severity}` : null,
      payload.status || alert.status ? `status: ${payload.status || alert.status}` : null,
      payload.description || alert.description || null,
    ].filter(Boolean).join('\n');
  const nowTs = `${Math.floor(Date.now() / 1000)}.${String(Date.now()).slice(-6)}`;

  return {
    ...source,
    type: source.type || 'message',
    channel: source.channel || payload.slack_channel || payload.slackChannel || payload.slackChannelId || process.env.SLACK_ALERT_CHANNEL_ID || 'LOCAL-DEMO',
    ts: source.ts || payload.slack_message_ts || payload.slackMessageTs || payload.slackMessageId || nowTs,
    thread_ts: source.thread_ts || payload.slack_thread_ts || payload.slackThreadTs || null,
    text,
    blocks: source.blocks || payload.blocks || [],
    attachments: source.attachments || payload.attachments || [],
    permalink: source.permalink || payload.slack_permalink || payload.slackPermalink || null,
  };
}

function applyIngestOverrides(parsedAlert, payload = {}) {
  const alert = payload.alert || {};
  const jiraIssueKey = payload.jira_key || payload.jiraKey || alert.jira_key || alert.jiraKey || parsedAlert.jiraIssueKey;
  const jiraUrl = payload.jira_url || payload.jiraUrl || alert.jira_url || alert.jiraUrl || parsedAlert.jiraUrl;

  return {
    ...parsedAlert,
    alertName: alert.title || alert.summary || payload.title || payload.summary || parsedAlert.alertName,
    severity: alert.severity || payload.severity || parsedAlert.severity,
    service: alert.service || payload.service || parsedAlert.service,
    environment: alert.environment || payload.environment || parsedAlert.environment,
    status: alert.status || payload.status || parsedAlert.status,
    source: alert.source_tool || alert.sourceTool || payload.source_tool || payload.sourceTool || parsedAlert.source,
    jiraIssueKey,
    jiraUrl,
    jiraKeys: jiraIssueKey ? [jiraIssueKey, ...(parsedAlert.jiraKeys || [])] : parsedAlert.jiraKeys,
  };
}

async function ingestAlertPayload(payload = {}) {
  await ensureAlertOptionalColumns();
  const event = buildSlackEventFromIngestPayload(payload);
  const rawPayload = {
    type: payload.type || 'manual_alert_ingest',
    source: payload.source || 'api',
    ...payload,
    event,
  };
  const parsedAlert = applyIngestOverrides(
    slackParser.parseSlackAlertMessage(event, rawPayload),
    payload,
  );
  const result = await storeSlackAlert(parsedAlert, {
    notifySlack: false,
  });

  return {
    ...result,
    dedupeIdentity: result.alert?.sourceAlertId || result.alert?.id || null,
  };
}

async function processAlert(id, options = {}) {
  throw retiredDecisionError();

  /* c8 ignore start -- retained only inside the rollback archive and unreachable after Phase 0. */
  const result = await classifyAlerts({
    force: options.force !== false,
    ids: [id],
  });
  const alert = result.alerts.find((item) => item.id === id) || await getAlertById(id);

  if (!alert) {
    return null;
  }

  return {
    alert,
    summary: result.summary,
  };
  /* c8 ignore stop */
}

async function getAlertRawPayload(id) {
  await ensureAlertOptionalColumns();
  const result = await db.query(
    `
      SELECT raw_payload, extracted_details
      FROM alerts
      WHERE id = $1 AND ${commandCenterAlertSql('alerts')}
    `,
    [id],
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    rawPayload: result.rows[0].raw_payload,
    extractedDetails: result.rows[0].extracted_details,
  };
}

async function getAlertLinkedIncidents(id) {
  await ensureAlertOptionalColumns();
  await assertCommandCenterAlertVisible(id);
  const mappingResult = await db.query(
    `
      SELECT
        alert_incident_mappings.id,
        alert_incident_mappings.alert_id,
        alert_incident_mappings.incident_id,
        alert_incident_mappings.jira_ticket_id,
        alert_incident_mappings.mapping_reason,
        alert_incident_mappings.created_at,
        incidents.recurring_incident
      FROM alert_incident_mappings
      LEFT JOIN incidents ON incidents.id = alert_incident_mappings.incident_id
      WHERE alert_incident_mappings.alert_id = $1
      ORDER BY alert_incident_mappings.created_at DESC
    `,
    [id],
  );
  const alertResult = await db.query(
    `
      SELECT id, source_alert_id, jira_ticket_id, extracted_details
      FROM alerts
      WHERE id = $1
    `,
    [id],
  );
  const alert = alertResult.rows[0];
  const alertKeys = [
    alert?.id,
    alert?.source_alert_id,
    ...(alert?.extracted_details?.alert?.alert_identifiers || []),
  ].filter(Boolean);
  const mappedIncidentKeys = mappingResult.rows.map((row) => row.jira_ticket_id).filter(Boolean);
  const operationResult = await db.query(
    `
      SELECT *
      FROM operations_incidents
      WHERE incident_key = ANY($1::text[])
        OR linked_alerts ?| $2::text[]
      ORDER BY incident_updated_at DESC NULLS LAST, incident_created_at DESC NULLS LAST
    `,
    [
      [...new Set([alert?.jira_ticket_id, ...mappedIncidentKeys].filter(Boolean))],
      [...new Set(alertKeys)],
    ],
  );

  const mapped = mappingResult.rows.map((row) => ({
    id: row.id,
    alertId: row.alert_id,
    incidentId: row.incident_id,
    jiraTicketId: row.jira_ticket_id,
    mappingReason: row.mapping_reason,
    recurringIncident: row.recurring_incident,
    createdAt: row.created_at,
  }));
  const operations = operationResult.rows.map((row) => ({
    id: row.incident_key,
    alertId: id,
    incidentId: null,
    jiraTicketId: row.incident_key,
    incidentKey: row.incident_key,
    summary: row.summary,
    description: row.description,
    status: row.status,
    priority: row.priority,
    resolution: row.resolution,
    assignee: displayNameFromJson(row.assignee),
    reporter: displayNameFromJson(row.reporter),
    sourceUrl: row.source_url,
    linkedAlerts: row.linked_alerts || [],
    rootCauseNotes: row.root_cause_notes || [],
    mappingReason: 'Stored JSM Operations incident linked by alert key or incident key.',
    recurringIncident: false,
    createdAt: row.incident_created_at,
    updatedAt: row.incident_updated_at,
    closedAt: row.closed_at,
  }));

  return [...operations, ...mapped];
}

async function getIncidents() {
  await ensureAlertOptionalColumns();
  const operationResult = await db.query(`
    SELECT
      incident_key,
      summary,
      description,
      reporter,
      priority,
      status,
      status_category,
      resolution,
      source_url,
      incident_created_at,
      incident_updated_at,
      closed_at,
      assignee,
      labels,
      linked_alerts,
      '[]'::jsonb AS root_cause_notes,
      '[]'::jsonb AS comments,
      '[]'::jsonb AS attachments,
      '{}'::jsonb AS custom_fields,
      NULL::jsonb AS incident_details,
      NULL::jsonb AS raw_payload,
      created_at,
      updated_at
    FROM operations_incidents
    ORDER BY incident_updated_at DESC NULLS LAST, incident_created_at DESC NULLS LAST
  `);
  const result = await db.query(`
    SELECT
      incidents.id AS incident_id,
      incidents.created_at AS incident_created_at,
      alerts.id,
      alerts.title,
      alerts.service,
      alerts.environment,
      alerts.severity,
      alerts.status,
      alerts.classification,
      alerts.noise_type,
      alerts.owner,
      alerts.received_at,
      alerts.last_seen_at,
      alerts.jira_ticket_id,
      alerts.source_url,
      alerts.recurring_incident
    FROM incidents
    INNER JOIN alerts ON alerts.id = incidents.alert_id
    ORDER BY alerts.last_seen_at DESC
  `);

  const operations = operationResult.rows.map((row) => mapOperationsIncidentRow(row, { includeDetails: false }));
  const operationKeys = new Set(operations.map((incident) => incident.jiraTicketId).filter(Boolean));
  const derived = result.rows
    .map(mapIncidentRow)
    .filter((incident) => !incident.jiraTicketId || !operationKeys.has(incident.jiraTicketId));

  return [...operations, ...derived];
}

async function getIncidentByKey(key) {
  await ensureAlertOptionalColumns();
  const operationResult = await db.query(
    `
      SELECT *
      FROM operations_incidents
      WHERE incident_key = $1
    `,
    [key],
  );

  if (operationResult.rows[0]) {
    return mapOperationsIncidentRow(operationResult.rows[0]);
  }

  return null;
}

async function syncIncidentForAlert(client, alert) {
  if (alert.classification === 'incident') {
    const incidentResult = await client.query(
      `
        INSERT INTO incidents (alert_id, recurring_incident, jira_ticket_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (alert_id)
        DO UPDATE SET
          recurring_incident = EXCLUDED.recurring_incident,
          jira_ticket_id = EXCLUDED.jira_ticket_id,
          updated_at = NOW()
        RETURNING id
      `,
      [alert.id, alert.recurring_incident, alert.jira_ticket_id],
    );
    await client.query(
      `
        INSERT INTO alert_incident_mappings (alert_id, incident_id, jira_ticket_id, mapping_reason)
        VALUES ($1, $2, $3, $4)
      `,
      [
        alert.id,
        incidentResult.rows[0]?.id || null,
        alert.jira_ticket_id,
        alert.classification_reason || 'Alert classified as incident.',
      ],
    );
    return;
  }

  await client.query('DELETE FROM incidents WHERE alert_id = $1', [alert.id]);
}

function buildActionUpdate(action, currentAlert, jiraTicketId) {
  if (action === 'incident') {
    return {
      classification: 'incident',
      status: 'investigating',
      noiseType: 'none',
      noiseReason: null,
      confidenceScore: 100,
      classificationReason: 'Manually marked as incident by an operator because this alert requires investigation.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: currentAlert.recurring_incident,
    };
  }

  if (action === 'noise') {
    return {
      classification: 'noise',
      status: 'suppressed',
      noiseType: currentAlert.noise_type === 'none' ? 'non-actionable' : currentAlert.noise_type,
      noiseReason: 'Manually marked as noise by an operator.',
      confidenceScore: 100,
      classificationReason: 'Classified as noise by operator review. This alert should not create incident work unless it reoccurs or severity changes.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: false,
    };
  }

  if (action === 'resolved') {
    return {
      classification: 'noise',
      status: 'resolved',
      noiseType: 'auto-resolved',
      noiseReason: 'Manually marked auto-resolved after recovery was confirmed.',
      confidenceScore: 100,
      classificationReason: 'Closed from the website after recovery was confirmed. This action was recorded in the backend audit trail.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: false,
    };
  }

  if (action === 'close') {
    return {
      classification: currentAlert.classification === 'unclassified' ? 'needs_review' : currentAlert.classification,
      status: 'closed',
      noiseType: currentAlert.noise_type || 'none',
      noiseReason: currentAlert.noise_reason,
      confidenceScore: currentAlert.confidence_score,
      classificationReason: 'Closed from the website by an operator after review.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: currentAlert.recurring_incident,
    };
  }

  if (action === 'duplicate') {
    return {
      classification: 'noise',
      status: 'deduplicated',
      noiseType: 'duplicate',
      noiseReason: 'Manually marked duplicate by an operator.',
      confidenceScore: 100,
      classificationReason: 'Classified as noise because it duplicates an existing alert signal and should be grouped.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: false,
    };
  }

  if (action === 'jira') {
    return {
      classification: 'incident',
      status: 'investigating',
      noiseType: 'none',
      noiseReason: null,
      confidenceScore: 100,
      classificationReason: 'Classified as incident because an ACC Jira incident was requested for active follow-up.',
      jiraTicketId,
      recurringIncident: currentAlert.recurring_incident,
    };
  }

  if (action === 'needs_review') {
    return {
      classification: 'needs_review',
      status: currentAlert.status === 'closed' ? 'closed' : 'investigating',
      noiseType: 'none',
      noiseReason: null,
      confidenceScore: 50,
      classificationReason: 'Marked as needs_review by an operator because more investigation is required before deciding noise or incident.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: currentAlert.recurring_incident,
    };
  }

  if (action === 'reopen') {
    return {
      classification: 'incident',
      status: 'open',
      noiseType: 'none',
      noiseReason: null,
      confidenceScore: 100,
      classificationReason: 'Reopened as an incident by an operator.',
      jiraTicketId: currentAlert.jira_ticket_id,
      recurringIncident: currentAlert.recurring_incident,
    };
  }

  const error = new Error(`Unsupported alert action: ${action}`);
  error.status = 400;
  throw error;
}

async function applyAlertAction(id, action, options = {}) {
  throw retiredDecisionError();

  /* c8 ignore start -- legacy operator classification actions are intentionally unreachable. */
  await ensureAlertOptionalColumns();
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query(`${selectAlertSql('WHERE id = $1')} FOR UPDATE`, [id]);
    const currentAlert = currentResult.rows[0];

    if (!currentAlert) {
      await client.query('ROLLBACK');
      return null;
    }

    assertInvestigationAllowed(currentAlert);

    const jiraTicketId =
      action === 'jira' && !currentAlert.jira_ticket_id
        ? await jiraService.createIssueForAlert(mapAlertRow(currentAlert))
        : currentAlert.jira_ticket_id;
    const update = buildActionUpdate(action, currentAlert, jiraTicketId);

    const updatedResult = await client.query(
      `
        UPDATE alerts
        SET
          classification = $2,
          status = $3,
          noise_type = $4,
          jira_ticket_id = $5,
          recurring_incident = $6,
          noise_reason = $7,
          classification_reason = $8,
          confidence_score = $9,
          last_seen_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING
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
          slack_channel_id,
          slack_message_ts,
          acknowledged,
          acknowledged_by,
          acknowledged_at,
          acknowledgement_source,
          escalation_status,
          escalated_at,
          escalation_reason,
          responders,
          raw_payload,
          extracted_details,
          noise_reason,
          classification_reason,
          duplicate_signature,
          correlation_id,
          received_at,
          last_seen_at,
          occurrences,
          owner,
          signal,
          description,
          jira_ticket_id,
          recurring_incident,
          related_alerts,
          '[]'::jsonb AS audit_events
      `,
      [
        id,
        update.classification,
        update.status,
        update.noiseType,
        update.jiraTicketId,
        update.recurringIncident,
        update.noiseReason,
        update.classificationReason,
        update.confidenceScore,
      ],
    );

    const updatedAlert = updatedResult.rows[0];
    await recordClassification(client, updatedAlert, 'operator');
    await recordCorrelation(client, updatedAlert);
    await syncIncidentForAlert(client, updatedAlert);
    await recordAuditEvent(
      client,
      id,
      'alert_action_applied',
      options.actor || 'operator',
      options.source || 'website',
      {
        action,
        alertSource: currentAlert.source,
        classification: update.classification,
        reason: options.reason || null,
        result: 'success',
        status: update.status,
        jiraTicketId: update.jiraTicketId,
      },
    );
    await client.query('COMMIT');

    return getMappedAlertById(id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  /* c8 ignore stop */
}

function buildSlackAlertId(parsedAlert) {
  const timestamp = String(parsedAlert.slackMessageTs || Date.now()).replace(/[^0-9]/g, '-');
  const channel = String(parsedAlert.slackChannelId || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
  return `SLACK-${channel}-${timestamp}`;
}

function hashIdentity(value) {
  return crypto
    .createHash('sha1')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function normalizeIdentityToken(value) {
  return String(value || '')
    .trim()
    .replace(/^#/, '')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getOpsAlertNumber(parsedAlert) {
  const candidates = [
    ...(parsedAlert.relatedAlerts || []),
    parsedAlert.alertName,
    parsedAlert.messageText,
  ];

  for (const candidate of candidates) {
    const match = String(candidate || '').match(/#(\d{3,})\b/);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function getOpsAlertLinkId(url) {
  const value = String(url || '');
  const directMatch = value.match(/\/jira\/ops\/alerts\/([^/?#]+)/i);
  const shortMatch = value.match(/\/a\/abcfinancial\/([^/?#]+)/i);

  return directMatch?.[1] || shortMatch?.[1] || null;
}

function buildStableSlackAlertIdentity(parsedAlert, sourceUrl, jiraIssueKey) {
  return alertDeduplication.buildStableSlackIdentity({
    parsedAlert,
    sourceUrl,
    jiraIssueKey,
    fallbackId: buildSlackAlertId(parsedAlert),
  });
}

function getSlackMessageRef(parsedAlert) {
  if (!parsedAlert.slackChannelId || !parsedAlert.slackMessageTs) {
    return null;
  }

  return `${parsedAlert.slackChannelId}:${parsedAlert.slackMessageTs}`;
}

function getStoredSlackMessageRefs(row = {}) {
  const refs = new Set();

  if (!row) {
    return refs;
  }

  const details = row.extracted_details || {};
  const messageRefs = details.slack?.message_refs || [];

  if (row.slack_channel_id && row.slack_message_ts) {
    refs.add(`${row.slack_channel_id}:${row.slack_message_ts}`);
  }

  if (Array.isArray(messageRefs)) {
    messageRefs.filter(Boolean).forEach((ref) => refs.add(String(ref)));
  }

  return refs;
}

function mergeSlackMessageRefs(extractedDetails, existingRow, parsedAlert) {
  const incomingRef = getSlackMessageRef(parsedAlert);
  const refs = getStoredSlackMessageRefs(existingRow);

  if (incomingRef) {
    refs.add(incomingRef);
  }

  return {
    ...extractedDetails,
    slack: {
      ...(extractedDetails.slack || {}),
      message_refs: [...refs],
      latest_message_ref: incomingRef,
      original_message_ref: [...refs][0] || incomingRef || null,
    },
  };
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
    ].map((valueToHash) => String(valueToHash || '').trim().toLowerCase()).join('|'))
    .digest('hex');
}

function isUnknownSource(source) {
  const normalized = String(source || '').trim().toLowerCase();

  return !normalized || normalized === 'unknown-monitoring-tool' || normalized === 'unknown';
}

function getJiraUrlFromIssue(jiraIssue, jiraKey, parsedAlert) {
  return parsedAlert?.jiraUrl
    || jiraIssue?.jira_url
    || jiraIssue?.issue_url
    || jiraIssue?.event_link
    || null;
}

function buildSlackEnrichmentSchema(parsedAlert, normalizedAlert, jiraIssue, jiraEnrichmentError) {
  const enrichment = parsedAlert.enrichment || {};
  const jiraIssueKey = parsedAlert.jiraIssueKey || jiraIssue?.issue_key || enrichment.jira_key || null;
  const jiraUrl = getJiraUrlFromIssue(jiraIssue, jiraIssueKey, parsedAlert);
  const canonicalJiraUrl = jiraIssue?.jira_url || jiraIssue?.issue_url || jiraIssue?.event_link || jiraUrl;
  const inferredMonitoringTool = isUnknownSource(enrichment.monitoring_tool)
    ? normalizedAlert.source
    : enrichment.monitoring_tool;
  const monitoringTool = isUnknownSource(inferredMonitoringTool) ? 'unknown' : inferredMonitoringTool;
  const monitoringEventUrl = enrichment.monitoring_event_url
    || parsedAlert.deepEventLink
    || jiraIssue?.deep_event_link
    || normalizedAlert.sourceUrl
    || parsedAlert.slackPermalink
    || null;

  return {
    alert_id: normalizedAlert.id,
    source_tool: normalizedAlert.source,
    alert_message: parsedAlert.messageText || normalizedAlert.signal,
    monitoring_tool: monitoringTool || 'unknown',
    monitoring_event_url: monitoringEventUrl,
    jira_key: jiraIssueKey,
    jira_url: jiraUrl,
    original_jira_url: parsedAlert.jiraUrl || jiraUrl,
    canonical_jira_url: canonicalJiraUrl,
    jira_summary: jiraIssue?.summary || null,
    jira_description: jiraIssue?.description || null,
    jira_status: jiraIssue?.status || null,
    jira_priority: jiraIssue?.priority || null,
    jira_assignee: jiraIssue?.assignee || null,
    jira_reporter: jiraIssue?.reporter || null,
    jira_project_key: jiraIssue?.project_key || null,
    jira_labels: jiraIssue?.labels || [],
    jira_components: jiraIssue?.components || [],
    jira_comments: jiraIssue?.comments || [],
    jira_changelog: jiraIssue?.changelog || [],
    jira_changelog_summary: jiraIssue?.changelog_summary || {},
    jira_custom_fields: jiraIssue?.custom_fields || {},
    jira_enrichment_error: jiraEnrichmentError || null,
    raw_jira_issue_payload: jiraIssue?.raw_issue_payload || jiraIssue?.raw_payload || null,
    raw_jira_comments_payload: jiraIssue?.raw_comments_payload || [],
    raw_jira_changelog_payload: jiraIssue?.raw_changelog_payload || [],
    slack_permalink: parsedAlert.slackPermalink || null,
    slack_assignee: parsedAlert.slackAssignee || null,
    slack_responders: normalizedAlert.responders || parsedAlert.slackResponders || [],
    slack_acknowledgement: parsedAlert.slackAcknowledgement || null,
    slack_acknowledged_by_user_id: normalizedAlert.acknowledgedByUserId || parsedAlert.slackAcknowledgement?.acknowledged_by_slack_user_id || null,
    slack_acknowledged_by_name: normalizedAlert.acknowledgedByName || null,
    raw_payload: parsedAlert.rawPayload || {},
  };
}

async function getSlackJiraEnrichment(parsedAlert) {
  const jiraIssueKey = parsedAlert.jiraIssueKey || parsedAlert.jiraKeys?.[0];

  if (!jiraIssueKey) {
    return {
      jiraIssue: null,
      jiraEnrichmentError: null,
    };
  }

  try {
    return {
      jiraIssue: await jiraService.getIssueDetails(jiraIssueKey),
      jiraEnrichmentError: null,
    };
  } catch (error) {
    return {
      jiraIssue: null,
      jiraEnrichmentError: error.message,
    };
  }
}

function buildSlackExtractedDetails(parsedAlert, normalizedAlert, jiraIssue, jiraEnrichmentError) {
  const jiraIssueKey = parsedAlert.jiraIssueKey || jiraIssue?.issue_key || null;
  const deepEventLink = parsedAlert.deepEventLink || jiraIssue?.deep_event_link || normalizedAlert.sourceUrl || null;
  const eventLink = parsedAlert.eventLink || jiraIssue?.event_link || normalizedAlert.sourceUrl || null;
  const slackEnrichment = buildSlackEnrichmentSchema(parsedAlert, normalizedAlert, jiraIssue, jiraEnrichmentError);
  const slackAcknowledgement = {
    ...(parsedAlert.slackAcknowledgement || {}),
    assignee: parsedAlert.slackAssignee || parsedAlert.slackAcknowledgement?.assignee || null,
    permalink: parsedAlert.slackPermalink || null,
    acknowledged_by_user_id: normalizedAlert.acknowledgedByUserId || parsedAlert.slackAcknowledgement?.acknowledged_by_slack_user_id || null,
    acknowledged_by_name: normalizedAlert.acknowledgedByName || null,
    responders: normalizedAlert.responders || parsedAlert.slackResponders || [],
  };
  const responders = normalizedAlert.responders || parsedAlert.slackResponders || [];

  return {
    slack_enrichment: slackEnrichment,
    alert: {
      alert_id: normalizedAlert.id,
      source_tool: normalizedAlert.source,
      source_type: 'slack_notification',
      service: normalizedAlert.service,
      environment: normalizedAlert.environment,
      severity: normalizedAlert.severity,
      message: parsedAlert.messageText || normalizedAlert.signal,
      timestamp: parsedAlert.receivedAt || null,
      status: normalizedAlert.status,
      occurrences: normalizedAlert.occurrences,
      event_link: eventLink,
      deep_event_link: deepEventLink,
      raw_payload: parsedAlert.rawPayload || {},
      owner: normalizedAlert.owner || 'Unassigned',
      responders,
      correlation_id: normalizedAlert.correlationId,
      duplicate_signature: normalizedAlert.duplicateSignature,
      related_alerts: parsedAlert.relatedAlerts || [],
      jira_key: jiraIssueKey,
      alert_message: parsedAlert.messageText || normalizedAlert.signal,
      monitoring_tool: slackEnrichment.monitoring_tool,
      monitoring_event_url: slackEnrichment.monitoring_event_url,
      jira_url: slackEnrichment.jira_url,
      original_jira_url: slackEnrichment.original_jira_url,
      canonical_jira_url: slackEnrichment.canonical_jira_url,
      jira_summary: slackEnrichment.jira_summary,
      jira_description: slackEnrichment.jira_description,
      jira_status: slackEnrichment.jira_status,
      jira_priority: slackEnrichment.jira_priority,
      jira_labels: slackEnrichment.jira_labels,
      jira_components: slackEnrichment.jira_components,
      slack_acknowledgement_status: slackAcknowledgement.status || null,
      slack_acknowledged_by: slackAcknowledgement.acknowledged_by || null,
      slack_acknowledged_by_slack_user_id: slackAcknowledgement.acknowledged_by_slack_user_id || null,
      slack_acknowledged_by_user_id: slackAcknowledgement.acknowledged_by_user_id || null,
      slack_acknowledged_by_name: slackAcknowledgement.acknowledged_by_name || null,
      slack_acknowledged_at: slackAcknowledgement.acknowledged_at || null,
      slack_assignee: slackAcknowledgement.assignee || null,
      slack_assignee_name: normalizedAlert.responders?.find((responder) => responder.role?.includes('assignee'))?.displayName || null,
      slack_responders: responders,
    },
    normalized_alert: {
      alert_id: normalizedAlert.id,
      source_tool: normalizedAlert.source,
      source_name: normalizedAlert.source,
      delivery_channel: 'slack',
      jira_issue_key: jiraIssueKey,
      jira_url: slackEnrichment.jira_url,
      original_jira_url: slackEnrichment.original_jira_url,
      canonical_jira_url: slackEnrichment.canonical_jira_url,
      jira_summary: slackEnrichment.jira_summary,
      jira_description: slackEnrichment.jira_description,
      jira_status: slackEnrichment.jira_status,
      jira_priority: slackEnrichment.jira_priority,
      monitoring_tool: slackEnrichment.monitoring_tool,
      monitoring_event_url: slackEnrichment.monitoring_event_url,
      slack_permalink: parsedAlert.slackPermalink || null,
      slack_acknowledgement_status: slackAcknowledgement.status || null,
      slack_acknowledged_by: slackAcknowledgement.acknowledged_by || null,
      slack_acknowledged_by_slack_user_id: slackAcknowledgement.acknowledged_by_slack_user_id || null,
      slack_acknowledged_by_user_id: slackAcknowledgement.acknowledged_by_user_id || null,
      slack_acknowledged_by_name: slackAcknowledgement.acknowledged_by_name || null,
      slack_acknowledged_at: slackAcknowledgement.acknowledged_at || null,
      slack_assignee: slackAcknowledgement.assignee || null,
      slack_assignee_name: normalizedAlert.responders?.find((responder) => responder.role?.includes('assignee'))?.displayName || null,
      responders,
      event_link: eventLink,
      deep_event_link: deepEventLink,
      priority: jiraIssue?.priority || null,
      severity: normalizedAlert.severity,
      state: normalizedAlert.status,
      tags: parsedAlert.relatedAlerts || [],
      reason_codes: [
        'delivery_channel=slack',
        `source_tool=${normalizedAlert.source}`,
        `jira_link_found=${Boolean(jiraIssueKey)}`,
        `deep_event_link_found=${Boolean(deepEventLink)}`,
      ],
      recommended_action: 'Preserve Slack notification context, linked Jira incident, and monitoring event for the future learning dataset.',
    },
    slack: {
      channel_id: parsedAlert.slackChannelId,
      message_ts: parsedAlert.slackMessageTs,
      thread_ts: parsedAlert.slackThreadTs,
      permalink: parsedAlert.slackPermalink,
      assignee: slackAcknowledgement.assignee || null,
      responders,
      acknowledgement: slackAcknowledgement,
      user: parsedAlert.user,
      bot_id: parsedAlert.botId,
      urls: parsedAlert.urls || [],
    },
    slack_acknowledgement: slackAcknowledgement,
    jira: jiraIssue ? {
      ...jiraIssue,
      jira_url: slackEnrichment.jira_url,
      issue_url: slackEnrichment.jira_url,
      original_jira_url: slackEnrichment.original_jira_url,
      canonical_jira_url: slackEnrichment.canonical_jira_url,
      raw_payload: jiraIssue.raw_payload,
    } : {
      issue_key: jiraIssueKey,
      jira_url: slackEnrichment.jira_url,
      original_jira_url: slackEnrichment.original_jira_url,
      canonical_jira_url: slackEnrichment.canonical_jira_url,
      enrichment_error: jiraEnrichmentError,
    },
    classification: notEvaluatedMetadata(),
  };
}

function shouldRefreshStoredSlackEnrichment(row = {}) {
  const sourceType = String(row.source_type || '').toLowerCase();
  const source = String(row.source || '').toLowerCase();
  const details = row.extracted_details || {};
  const hasSlackIdentity = Boolean(row.slack_channel_id && row.slack_message_ts);
  const isSlackAlert = hasSlackIdentity || sourceType.includes('slack') || source === 'slack';
  const hasEnrichment = Boolean(details.slack_enrichment?.monitoring_tool);
  const rawText = JSON.stringify(row.raw_payload || {});
  const hasJiraEvidence = Boolean(
    details.slack_enrichment?.jira_key
    || details.normalized_alert?.jira_issue_key
    || details.alert?.jira_key
    || details.jira?.issue_key
    || /\b[A-Z][A-Z0-9]+-\d+\b/.test(rawText)
    || /atlassian\.net|\/browse\/[A-Z][A-Z0-9]+-\d+/i.test(rawText),
  );
  const hasJiraDetails = Boolean(details.jira?.summary || details.slack_enrichment?.jira_summary);
  const jiraLookupAlreadyFailed = Boolean(details.jira?.enrichment_error || details.slack_enrichment?.jira_enrichment_error);
  const hasFullJiraEnrichment = Boolean(
    details.jira?.raw_issue_payload
    && Array.isArray(details.jira?.raw_comments_payload)
    && Array.isArray(details.jira?.raw_changelog_payload),
  );
  const hasLatestJiraEnrichment = Boolean(
    hasFullJiraEnrichment
    && details.jira?.raw_field_names_payload
    && Array.isArray(details.jira?.changelog_summary?.priority_changes),
  );
  const hasSlackAcknowledgementDetails = Boolean(
    details.slack_acknowledgement?.status
    || details.slack_acknowledgement?.acknowledged_by
    || details.slack_acknowledgement?.acknowledged_at
    || details.slack?.acknowledgement?.status
    || details.slack_enrichment?.slack_acknowledgement?.status,
  );
  const hasSlackAcknowledgementEvidence = /\backnowledged the alert\b|(?:^|["\s])status(?:\\n|\s|["':,-])+acknowledged\b/i.test(rawText);
  const hasBaseAtlassianUrlWithoutJiraKey = Boolean(
    details.slack_enrichment?.jira_url
    && !details.slack_enrichment?.jira_key
    && /^https?:\/\/[^/]*atlassian\.net\/?$/i.test(details.slack_enrichment.jira_url),
  );

  return isSlackAlert
    && row.raw_payload
    && (
      !hasEnrichment
      || (hasJiraEvidence && !hasJiraDetails && !jiraLookupAlreadyFailed)
      || (hasJiraEvidence && hasJiraDetails && !hasLatestJiraEnrichment && !jiraLookupAlreadyFailed)
      || (hasSlackAcknowledgementEvidence && !hasSlackAcknowledgementDetails)
      || hasBaseAtlassianUrlWithoutJiraKey
    );
}

function buildStoredSlackEvent(row = {}) {
  const rawPayload = row.raw_payload || {};
  const message = rawPayload.message || rawPayload.event || {};

  return {
    ...message,
    channel: row.slack_channel_id || message.channel || rawPayload.channel,
    ts: row.slack_message_ts || message.ts,
    permalink: message.permalink || rawPayload.permalink || null,
  };
}

async function refreshStoredSlackAlertEnrichment(row = {}) {
  const event = buildStoredSlackEvent(row);

  if (!event.channel || !event.ts) {
    return;
  }

  try {
    const parsedAlert = slackParser.parseSlackAlertMessage(event, row.raw_payload || {});
    const { jiraIssue, jiraEnrichmentError } = await getSlackJiraEnrichment(parsedAlert);
    const parsedSource = parsedAlert.enrichment?.monitoring_tool || parsedAlert.source;
    const source = isUnknownSource(parsedSource) && !isUnknownSource(jiraIssue?.source_tool)
      ? jiraIssue.source_tool
      : parsedSource || row.source || 'unknown-monitoring-tool';
    const sourceUrl = parsedAlert.enrichment?.monitoring_event_url
      || parsedAlert.deepEventLink
      || parsedAlert.eventLink
      || jiraIssue?.deep_event_link
      || jiraIssue?.event_link
      || row.source_url
      || parsedAlert.slackPermalink
      || null;
    const normalizedAlert = {
      id: row.id,
      title: row.title || parsedAlert.alertName,
      service: row.service || parsedAlert.service,
      environment: row.environment || parsedAlert.environment,
      severity: row.severity || parsedAlert.severity,
      status: row.status || parsedAlert.status,
      source,
      sourceType: row.source_type || parsedAlert.deliveryChannel || 'slack',
      sourceAlertId: row.source_alert_id || `${parsedAlert.slackChannelId}:${parsedAlert.slackMessageTs}`,
      sourceUrl,
      occurrences: row.occurrences || 1,
      signal: row.signal || parsedAlert.messageText || parsedAlert.alertName,
      description: row.description || `Slack alert notification collected from channel ${parsedAlert.slackChannelId}.`,
      rawPayload: row.raw_payload || {},
      duplicateSignature: row.duplicate_signature,
      correlationId: row.correlation_id || `${parsedAlert.slackChannelId}:${parsedAlert.slackMessageTs}`,
      owner: row.owner || 'Unassigned',
      responders: row.responders || [],
    };
    const slackAcknowledgement = parsedAlert.slackAcknowledgement || {};
    const acknowledgedSlackUserId = slackAcknowledgement.acknowledged_by_slack_user_id
      || (isSlackUserId(slackAcknowledgement.acknowledged_by) ? slackAcknowledgement.acknowledged_by : null);
    const acknowledgedByRaw = acknowledgedSlackUserId || slackAcknowledgement.acknowledged_by || null;
    const acknowledgedByName = acknowledgedByRaw
      ? await slackUserService.resolveSlackUserName(acknowledgedByRaw)
      : null;
    const slackResponders = buildSlackResponders(parsedAlert, {
      acknowledged: Boolean(slackAcknowledgement.acknowledged),
      acknowledgedBy: acknowledgedByName || acknowledgedByRaw,
      slackUserId: acknowledgedSlackUserId,
      acknowledgedAt: slackAcknowledgement.acknowledged_at || parsedAlert.receivedAt || null,
    });

    normalizedAlert.acknowledgedByUserId = acknowledgedSlackUserId;
    normalizedAlert.acknowledgedByName = acknowledgedByName;
    normalizedAlert.responders = await slackUserService.resolveResponders(mergeResponders(row.responders || [], slackResponders, {
      source: 'slack_message',
      status: slackAcknowledgement.acknowledged ? 'acknowledged' : 'detected',
      assignedAt: slackAcknowledgement.acknowledged_at || parsedAlert.receivedAt || null,
    }));
    const extractedDetails = buildSlackExtractedDetails(
      parsedAlert,
      normalizedAlert,
      jiraIssue,
      jiraEnrichmentError,
    );
    const jiraIssueKey = parsedAlert.jiraIssueKey || jiraIssue?.issue_key || row.jira_ticket_id || null;

    await db.query(
      `
        UPDATE alerts
        SET
          source = $2,
          source_url = $3,
          extracted_details = $4::jsonb,
          jira_ticket_id = COALESCE($5, jira_ticket_id),
          responders = $6::jsonb,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        row.id,
        normalizedAlert.source,
        normalizedAlert.sourceUrl,
        JSON.stringify(extractedDetails),
        jiraIssueKey,
        JSON.stringify(normalizedAlert.responders || []),
      ],
    );
  } catch (error) {
    console.warn('Stored Slack alert enrichment refresh failed', {
      alertId: row.id,
      slackChannelId: row.slack_channel_id,
      slackMessageTs: row.slack_message_ts,
      error: error.message,
    });
  }
}

function buildSlackAcknowledgementPayload(alert) {
  return {
    channel: alert.slackChannelId || process.env.SLACK_ALERT_CHANNEL_ID,
    thread_ts: alert.slackMessageTs || undefined,
    text: `Acknowledge required: ${alert.title}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Alert acknowledgement required',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Alert:*\n${alert.title}` },
          { type: 'mrkdwn', text: `*Severity:*\n${alert.severity || 'unknown'}` },
          { type: 'mrkdwn', text: `*Priority:*\n${alert.priority || 'not set'}` },
          { type: 'mrkdwn', text: `*Source tool:*\n${alert.source || 'unknown'}` },
          { type: 'mrkdwn', text: `*Service:*\n${alert.service || 'unknown-service'}` },
          { type: 'mrkdwn', text: `*Jira:*\n${alert.jiraTicketId || 'not linked'}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':warning: Acknowledge within 2 minutes. Investigation in the website starts after acknowledgement.',
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'acknowledge_alert',
            text: {
              type: 'plain_text',
              text: 'Acknowledge',
              emoji: true,
            },
            style: 'primary',
            value: alert.id,
          },
        ],
      },
    ],
  };
}

async function storeSlackNotificationRecord(alert, payload, status, messageTs = null, notificationType = 'alert_acknowledgement') {
  await db.query(
    `
      INSERT INTO slack_notifications (
        alert_id,
        channel_id,
        message_ts,
        payload,
        notification_type,
        status,
        sent_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, CASE WHEN $6 = 'sent' THEN NOW() ELSE NULL END)
    `,
    [
      alert.id,
      payload.channel || alert.slackChannelId || null,
      messageTs || payload.thread_ts || alert.slackMessageTs || null,
      JSON.stringify(payload),
      notificationType,
      status,
    ],
  );
}

async function postSlackNotification(alert, payload, notificationType) {
  if (!alert?.id || !alert.slackChannelId) {
    return;
  }

  let slackConfig = null;

  try {
    slackConfig = await integrationService.getSlackRuntimeConfig();
  } catch {
    slackConfig = null;
  }

  const token = slackConfig?.botToken || process.env.SLACK_BOT_TOKEN;
  const messagePayload = {
    ...payload,
    channel: payload.channel || alert.slackChannelId || slackConfig?.alertChannelId,
  };

  if (!token || typeof fetch !== 'function') {
    await storeSlackNotificationRecord(alert, messagePayload, 'pending', null, notificationType);
    return;
  }

  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });
    const result = await response.json().catch(() => ({}));

    await storeSlackNotificationRecord(
      alert,
      messagePayload,
      response.ok && result.ok ? 'sent' : 'failed',
      result.ts || null,
      notificationType,
    );
  } catch (error) {
    await storeSlackNotificationRecord(alert, {
      ...messagePayload,
      postError: error.message,
    }, 'failed', null, notificationType);
  }
}

async function sendSlackAcknowledgementPrompt(alert) {
  const payload = buildSlackAcknowledgementPayload(alert);

  await postSlackNotification(alert, payload, 'alert_acknowledgement');
}

function queueSlackAcknowledgementPrompt(alert) {
  setTimeout(() => {
    sendSlackAcknowledgementPrompt(alert).catch((error) => {
      console.error('Slack acknowledgement prompt failed', error);
    });
  }, 0);
}

function buildSlackEscalationPayload(alert) {
  return {
    channel: alert.slackChannelId || process.env.SLACK_ALERT_CHANNEL_ID,
    thread_ts: alert.slackMessageTs || undefined,
    text: `Escalated: ${alert.title}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Alert escalated',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Alert:*\n${alert.title}` },
          { type: 'mrkdwn', text: `*Severity:*\n${alert.severity || 'unknown'}` },
          { type: 'mrkdwn', text: `*Service:*\n${alert.service || 'unknown-service'}` },
          { type: 'mrkdwn', text: `*Reason:*\n${alert.escalationReason || 'No acknowledgement within 2 minutes'}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':rotating_light: This alert is still stored in the backend. Investigation remains in the website after acknowledgement.',
          },
        ],
      },
    ],
  };
}

function queueSlackEscalationNotification(alert) {
  setTimeout(() => {
    postSlackNotification(alert, buildSlackEscalationPayload(alert), 'alert_escalation').catch((error) => {
      console.error('Slack escalation notification failed', error);
    });
  }, 0);
}

async function storeSlackAlert(parsedAlert, options = {}) {
  await ensureAlertOptionalColumns();
  const { jiraIssue, jiraEnrichmentError } = await getSlackJiraEnrichment(parsedAlert);
  if (jiraEnrichmentError) {
    console.warn('Slack Jira enrichment failed', {
      jiraIssueKey: parsedAlert.jiraIssueKey || parsedAlert.jiraKeys?.[0] || null,
      slackChannelId: parsedAlert.slackChannelId,
      slackMessageTs: parsedAlert.slackMessageTs,
      error: jiraEnrichmentError,
    });
  }
  const parsedSource = parsedAlert.enrichment?.monitoring_tool || parsedAlert.source;
  const source = isUnknownSource(parsedSource) && !isUnknownSource(jiraIssue?.source_tool)
    ? jiraIssue.source_tool
    : parsedSource || 'unknown-monitoring-tool';
  const sourceUrl = parsedAlert.enrichment?.monitoring_event_url
    || parsedAlert.deepEventLink
    || parsedAlert.eventLink
    || jiraIssue?.deep_event_link
    || jiraIssue?.event_link
    || parsedAlert.slackPermalink
    || null;
  const jiraIssueKey = parsedAlert.jiraIssueKey || jiraIssue?.issue_key || null;
  const stableIdentity = buildStableSlackAlertIdentity(parsedAlert, sourceUrl, jiraIssueKey);
  const rawPayload = parsedAlert.rawPayload || {};
  const slackAcknowledgement = parsedAlert.slackAcknowledgement || {};
  const acknowledged = Boolean(slackAcknowledgement.acknowledged);
  const acknowledgedSlackUserId = slackAcknowledgement.acknowledged_by_slack_user_id
    || (isSlackUserId(slackAcknowledgement.acknowledged_by) ? slackAcknowledgement.acknowledged_by : null);
  const acknowledgedByRaw = acknowledged
    ? acknowledgedSlackUserId || slackAcknowledgement.acknowledged_by || parsedAlert.slackAssignee || 'Slack user'
    : null;
  const acknowledgedByName = acknowledged
    ? await slackUserService.resolveSlackUserName(acknowledgedByRaw)
    : null;
  const acknowledgedAt = acknowledged
    ? slackAcknowledgement.acknowledged_at || parsedAlert.receivedAt || new Date().toISOString()
    : null;
  const receivedAt = parsedAlert.receivedAt || new Date().toISOString();
  const status = acknowledged ? 'acknowledged' : parsedAlert.status;
  const normalizedAlert = {
    id: stableIdentity.id,
    title: parsedAlert.alertName,
    service: parsedAlert.service,
    environment: parsedAlert.environment,
    severity: parsedAlert.severity,
    status,
    source,
    sourceType: parsedAlert.deliveryChannel || 'slack',
    sourceAlertId: stableIdentity.sourceAlertId,
    sourceUrl,
    occurrences: 1,
    signal: parsedAlert.messageText || parsedAlert.alertName,
    description: `Slack alert notification collected from channel ${parsedAlert.slackChannelId}.`,
    rawPayload,
    duplicateSignature: null,
    correlationId: stableIdentity.sourceAlertId,
    owner: 'Unassigned',
    responders: [],
    acknowledgedByUserId: acknowledgedSlackUserId,
    acknowledgedByName,
  };
  normalizedAlert.duplicateSignature = buildDuplicateSignature(normalizedAlert);
  const relatedAlerts = parsedAlert.relatedAlerts || [];
  const primaryRelatedAlert = relatedAlerts[0] || null;
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      `
        SELECT *
        FROM alerts
        WHERE
          (slack_channel_id = $1 AND slack_message_ts = $2)
          OR id = $3
          OR source_alert_id = $4
          OR ($5::text IS NOT NULL AND source_url = $5)
          OR (
            $6::text IS NOT NULL
            AND related_alerts ? $6
            AND (
              source_type ILIKE '%slack%'
              OR source_alert_id LIKE 'ops-alert:%'
              OR id LIKE 'SLACK-%'
            )
          )
          OR ($7::boolean AND $8::text IS NOT NULL AND jira_ticket_id = $8)
        ORDER BY
          CASE
            WHEN slack_channel_id = $1 AND slack_message_ts = $2 THEN 0
            WHEN source_alert_id = $4 THEN 1
            WHEN id = $3 THEN 2
            WHEN $6::text IS NOT NULL
              AND related_alerts ? $6
              AND (
                source_type ILIKE '%slack%'
                OR source_alert_id LIKE 'ops-alert:%'
                OR id LIKE 'SLACK-%'
              )
              THEN 3
            WHEN $5::text IS NOT NULL AND source_url = $5 THEN 4
            WHEN $7::boolean AND $8::text IS NOT NULL AND jira_ticket_id = $8 THEN 5
            ELSE 9
          END,
          updated_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [
        parsedAlert.slackChannelId,
        parsedAlert.slackMessageTs,
        normalizedAlert.id,
        normalizedAlert.sourceAlertId,
        normalizedAlert.sourceUrl,
        primaryRelatedAlert,
        stableIdentity.canMatchByJira,
        jiraIssueKey,
      ],
    );
    const existingAlert = existingResult.rows[0] || null;
    const wasExisting = Boolean(existingAlert);
    const incomingSlackRef = getSlackMessageRef(parsedAlert);
    const existingSlackRefs = getStoredSlackMessageRefs(existingAlert);
    const occurrenceIncrement = incomingSlackRef && existingSlackRefs.has(incomingSlackRef) ? 0 : 1;

    if (existingAlert) {
      normalizedAlert.id = existingAlert.id;
      normalizedAlert.owner = existingAlert.owner || normalizedAlert.owner;
    }

    const slackResponders = buildSlackResponders(parsedAlert, {
      acknowledged,
      acknowledgedBy: acknowledgedByName || acknowledgedByRaw,
      slackUserId: acknowledgedSlackUserId,
      acknowledgedAt,
    });
    normalizedAlert.responders = await slackUserService.resolveResponders(mergeResponders(existingAlert?.responders || [], slackResponders, {
      source: 'slack_message',
      status: acknowledged ? 'acknowledged' : 'detected',
      assignedAt: acknowledgedAt || receivedAt,
    }));

    const extractedDetails = mergeSlackMessageRefs(
      {
        ...buildSlackExtractedDetails(
          parsedAlert,
          normalizedAlert,
          jiraIssue,
          jiraEnrichmentError,
        ),
        stable_identity: stableIdentity,
      },
      existingAlert,
      parsedAlert,
    );

    const rawResult = await client.query(
      `
        INSERT INTO raw_alerts (
          source_tool,
          source_type,
          source_alert_id,
          raw_payload,
          processing_status
        )
        VALUES ($1, $2, $3, $4::jsonb, 'stored')
        RETURNING id
      `,
      [
        normalizedAlert.source,
        normalizedAlert.sourceType,
        normalizedAlert.sourceAlertId,
        JSON.stringify(rawPayload),
      ],
    );

    await client.query(
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
          slack_channel_id,
          slack_message_ts,
          acknowledged,
          acknowledged_by,
          acknowledged_at,
          acknowledgement_source,
          responders,
          raw_payload,
          extracted_details,
          noise_reason,
          classification_reason,
          duplicate_signature,
          correlation_id,
          received_at,
          last_seen_at,
          occurrences,
          owner,
          signal,
          description,
          jira_ticket_id,
          recurring_incident,
          related_alerts
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          'unclassified', 'none', NULL,
          $15, $16, $7, $17,
          $8, $9, $23, $24, $25::timestamptz, $26, $28::jsonb,
          $10::jsonb, $18::jsonb,
          NULL, NULL,
          $11, $12,
          $19::timestamptz, $19::timestamptz, 1, $20, $13, $14,
          $21, false, $22::jsonb
        )
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          service = EXCLUDED.service,
          environment = EXCLUDED.environment,
          severity = EXCLUDED.severity,
          status = CASE
            WHEN alerts.status IN ('resolved', 'recovered', 'closed') THEN alerts.status
            WHEN EXCLUDED.acknowledged THEN 'acknowledged'
            ELSE EXCLUDED.status
          END,
          source = EXCLUDED.source,
          source_type = EXCLUDED.source_type,
          source_alert_id = EXCLUDED.source_alert_id,
          source_url = EXCLUDED.source_url,
          slack_channel_id = EXCLUDED.slack_channel_id,
          slack_message_ts = EXCLUDED.slack_message_ts,
          acknowledged = alerts.acknowledged OR EXCLUDED.acknowledged,
          acknowledged_by = COALESCE(EXCLUDED.acknowledged_by, alerts.acknowledged_by),
          acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, alerts.acknowledged_at),
          acknowledgement_source = COALESCE(EXCLUDED.acknowledgement_source, alerts.acknowledgement_source),
          responders = EXCLUDED.responders,
          raw_payload = EXCLUDED.raw_payload,
          extracted_details = COALESCE(alerts.extracted_details, '{}'::jsonb) || (EXCLUDED.extracted_details - 'classification'),
          duplicate_signature = EXCLUDED.duplicate_signature,
          correlation_id = EXCLUDED.correlation_id,
          last_seen_at = GREATEST(alerts.last_seen_at, EXCLUDED.last_seen_at),
          occurrences = alerts.occurrences + $27::int,
          signal = EXCLUDED.signal,
          description = EXCLUDED.description,
          jira_ticket_id = COALESCE(EXCLUDED.jira_ticket_id, alerts.jira_ticket_id),
          related_alerts = EXCLUDED.related_alerts,
          updated_at = NOW()
      `,
      [
        normalizedAlert.id,
        normalizedAlert.title,
        normalizedAlert.service,
        normalizedAlert.environment,
        normalizedAlert.severity,
        normalizedAlert.status,
        normalizedAlert.sourceAlertId,
        parsedAlert.slackChannelId,
        parsedAlert.slackMessageTs,
        JSON.stringify(rawPayload),
        normalizedAlert.duplicateSignature,
        normalizedAlert.correlationId,
        normalizedAlert.signal,
        normalizedAlert.description,
        normalizedAlert.source,
        normalizedAlert.sourceType,
        normalizedAlert.sourceUrl,
        JSON.stringify(extractedDetails),
        receivedAt,
        normalizedAlert.owner,
        jiraIssueKey,
        JSON.stringify(relatedAlerts),
        acknowledged,
        acknowledgedByRaw,
        acknowledgedAt,
        acknowledged ? 'slack_message' : null,
        occurrenceIncrement,
        JSON.stringify(normalizedAlert.responders || []),
      ],
    );

    if (acknowledged) {
      await client.query(
        `
          INSERT INTO alert_acknowledgements (
            alert_id,
            acknowledged_by,
            slack_user_id,
            acknowledgement_source,
            acknowledged_at
          )
          SELECT $1, $2, $3, 'slack_message', $4::timestamptz
          WHERE NOT EXISTS (
            SELECT 1
            FROM alert_acknowledgements
            WHERE alert_id = $1
              AND acknowledged_by = $2
              AND acknowledged_at = $4::timestamptz
          )
        `,
        [
          normalizedAlert.id,
          acknowledgedByRaw,
          acknowledgedSlackUserId || slackAcknowledgement.acknowledged_by || null,
          acknowledgedAt,
        ],
      );
    }

    await client.query(
      `
        UPDATE raw_alerts
        SET normalized_alert_id = $2,
            processing_status = 'normalized'
        WHERE id = $1
      `,
      [rawResult.rows[0].id, normalizedAlert.id],
    );

    await recordAuditEvent(client, normalizedAlert.id, 'slack_alert_stored', 'Slack', 'slack', {
      slackChannelId: parsedAlert.slackChannelId,
      slackMessageTs: parsedAlert.slackMessageTs,
      jiraIssueKey,
      sourceTool: normalizedAlert.source,
      deepEventLink: normalizedAlert.sourceUrl,
      acknowledgementRequiredWithinMinutes: 2,
    });

    await client.query('COMMIT');

    const alert = await getMappedAlertById(normalizedAlert.id);
    if (options.notifySlack === true) {
      queueSlackAcknowledgementPrompt(alert);
    }

    return {
      stored: true,
      result: wasExisting ? 'updated' : 'inserted',
      alert,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function classifyAlerts({ force = false, ids = [] } = {}) {
  throw retiredDecisionError();

  /* c8 ignore start -- legacy automatic classifier retained only for rollback reference. */
  await ensureAlertOptionalColumns();
  const client = await db.pool.connect();
  const targetIds = new Set(ids.filter(Boolean));
  const hasTargetIds = targetIds.size > 0;

  try {
    await client.query('BEGIN');

    const whereClause = hasTargetIds ? 'WHERE id = ANY($1::text[])' : '';
    const queryParams = hasTargetIds ? [[...targetIds]] : [];
    const result = await client.query(
      `${selectAlertSql(whereClause, { includeDetails: false })} ORDER BY received_at DESC FOR UPDATE`,
      queryParams,
    );
    const rows = result.rows;
    const summary = {
      checked: hasTargetIds ? targetIds.size : rows.length,
      updated: 0,
      incidents: 0,
      noise: 0,
      unclassified: 0,
      skippedUnacknowledged: 0,
    };
    const updatedAlerts = [];

    for (const row of rows) {
      if (hasTargetIds && !targetIds.has(row.id)) {
        continue;
      }

      if (requiresAcknowledgement(row) && !row.acknowledged) {
        summary.skippedUnacknowledged += 1;
        await recordAuditEvent(client, row.id, 'classification_blocked_until_acknowledged', 'system', 'backend', {
          reason: 'Slack-notified alert must be acknowledged before investigation/classification.',
        });
        continue;
      }

      if (!force && !['unclassified', 'needs_review'].includes(row.classification)) {
        if (row.classification === 'incident') {
          summary.incidents += 1;
        } else if (row.classification === 'noise') {
          summary.noise += 1;
        }
        continue;
      }

      const classified = classificationService.classifyAlert(row, rows);
      const classificationReason = buildClassificationReasonWithWorkflow(row, classified);
      const updatedResult = await client.query(
        `
          UPDATE alerts
          SET
            classification = $2,
            noise_type = $3,
            noise_reason = $4,
            classification_reason = $5,
            confidence_score = $6,
            updated_at = NOW()
          WHERE id = $1
          RETURNING
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
            slack_channel_id,
            slack_message_ts,
            acknowledged,
            acknowledged_by,
            acknowledged_at,
            acknowledgement_source,
            escalation_status,
            escalated_at,
            escalation_reason,
            responders,
            raw_payload,
            extracted_details,
            noise_reason,
            classification_reason,
            duplicate_signature,
            correlation_id,
            received_at,
            last_seen_at,
            occurrences,
            owner,
            signal,
            description,
            jira_ticket_id,
            recurring_incident,
            related_alerts,
            '[]'::jsonb AS audit_events
        `,
        [
          row.id,
          classified.classification,
          classified.noiseType,
          classified.noiseReason,
          classificationReason,
          classified.confidenceScore,
        ],
      );
      const updatedAlert = updatedResult.rows[0];

      await recordClassification(client, updatedAlert, 'system');
      await recordCorrelation(client, updatedAlert);
      await syncIncidentForAlert(client, updatedAlert);
      updatedAlerts.push(mapAlertRow(updatedAlert, { includeDetails: false }));
      summary.updated += 1;

      if (classified.classification === 'incident') {
        summary.incidents += 1;
      } else if (classified.classification === 'noise') {
        summary.noise += 1;
      } else {
        summary.unclassified += 1;
      }
    }

    await client.query('COMMIT');

    const responseAlerts = await enrichAlertsSlackUsers(
      rows.map((row) => updatedAlerts.find((alert) => alert.id === row.id) || mapAlertRow(row, { includeDetails: false })),
    );

    return {
      summary,
      alerts: responseAlerts,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  /* c8 ignore stop */
}

module.exports = {
  acknowledgeAlert,
  addAlertNote,
  addAlertResponder,
  applyAlertAction,
  classifyAlerts,
  ensureAlertOptionalColumns,
  escalateAlert,
  escalateExpiredAlerts,
  getAlertActivity,
  getAlertCount,
  getAlertLinkedIncidents,
  getAlertById,
  getAlertRawPayload,
  getAlertTrend,
  getAlerts,
  getSourceDashboardSummary,
  getIncidentByKey,
  getIncidents,
  ingestAlertPayload,
  linkJiraIncident,
  processAlert,
  storeSlackAlert,
};
