const crypto = require('crypto');
const db = require('../config/db');
const slackIngestionService = require('./slackIngestion.service');
const {
  getCompleteMessageText,
  normalizeSlackAlert,
  normalizeSlackRecord,
} = require('./slackAlertNormalizer.service');
const { isCommandCenterAlert } = require('./commandCenterEligibility.service');

let storageEnsured = false;
let syncInProgress = false;
let incrementalSyncInProgress = false;
let incrementalSlackContext = null;
const eventIngestions = new Map();

const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_FRESH_SECONDS = 60;
const DEFAULT_STALE_SECONDS = 300;

function isPermanentSlackEventsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.pathname === '/api/slack/events'
      && !['localhost', '127.0.0.1'].includes(url.hostname)
      && !/trycloudflare\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function getEvidenceCollectionMode(env = process.env) {
  const configured = String(env.EVIDENCE_COLLECTION_MODE || 'disabled').trim().toLowerCase();
  return {
    enabled: configured === 'enabled',
    value: configured === 'enabled' ? 'enabled' : 'disabled',
  };
}

function isPotentialAlertMessage(message = {}) {
  const text = getCompleteMessageText(message);
  return /\balert\b/i.test(text) && /(?:#\s*)?\d{3,}/.test(text);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function getLiveSyncConfig(env = process.env) {
  const freshSeconds = boundedInteger(
    env.SLACK_FRESH_SECONDS,
    DEFAULT_FRESH_SECONDS,
    10,
    3600,
  );
  const staleSeconds = boundedInteger(
    env.SLACK_STALE_SECONDS,
    DEFAULT_STALE_SECONDS,
    freshSeconds + 1,
    24 * 60 * 60,
  );

  return {
    pollIntervalSeconds: boundedInteger(
      env.SLACK_POLL_INTERVAL_SECONDS,
      DEFAULT_POLL_INTERVAL_SECONDS,
      10,
      3600,
    ),
    freshSeconds,
    staleSeconds,
  };
}

async function ensureStorage() {
  if (storageEnsured) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS slack_raw_messages (
      slack_channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      slack_channel_name TEXT,
      thread_ts TEXT,
      parent_message_ts TEXT,
      message_type TEXT NOT NULL DEFAULT 'message',
      author_id TEXT,
      author_name TEXT,
      message_text TEXT,
      complete_text TEXT,
      message_at TIMESTAMPTZ,
      reply_count INTEGER NOT NULL DEFAULT 0,
      reactions JSONB NOT NULL DEFAULT '[]'::jsonb,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      permalink TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      slack_event_id TEXT,
      ingestion_received_at TIMESTAMPTZ,
      parsing_status TEXT NOT NULL DEFAULT 'UNASSESSED',
      ingestion_error_code TEXT,
      ingestion_error TEXT,
      parsed_alert_number TEXT,
      parsed_alert_name TEXT,
      parsed_source TEXT,
      parsed_priority TEXT,
      parsed_responder TEXT,
      ingestion_mode TEXT NOT NULL DEFAULT 'historical',
      archive_scope TEXT NOT NULL DEFAULT 'OPERATIONAL',
      live_received_at TIMESTAMPTZ,
      first_stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (slack_channel_id, message_ts)
    );

    CREATE TABLE IF NOT EXISTS slack_alert_events (
      slack_channel_id TEXT NOT NULL,
      source_message_ts TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      alert_number TEXT NOT NULL,
      slack_channel_name TEXT,
      title TEXT,
      source_system TEXT NOT NULL DEFAULT 'Unknown',
      severity TEXT,
      priority TEXT,
      service TEXT,
      application TEXT,
      environment TEXT,
      tier TEXT,
      team TEXT,
      responder TEXT,
      status TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      description TEXT,
      runbook TEXT,
      source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      message_at TIMESTAMPTZ,
      slack_permalink TEXT,
      thread_ts TEXT,
      reply_count INTEGER NOT NULL DEFAULT 0,
      author_id TEXT,
      author_name TEXT,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_message TEXT NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      live_received_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (slack_channel_id, source_message_ts)
    );

    CREATE TABLE IF NOT EXISTS slack_normalized_alerts (
      id TEXT PRIMARY KEY,
      slack_channel_id TEXT NOT NULL,
      slack_channel_name TEXT,
      source_message_ts TEXT NOT NULL,
      alert_number TEXT NOT NULL,
      title TEXT,
      source_system TEXT NOT NULL DEFAULT 'Unknown',
      severity TEXT,
      priority TEXT,
      service TEXT,
      application TEXT,
      environment TEXT,
      tier TEXT,
      team TEXT,
      responder TEXT,
      status TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      description TEXT,
      runbook TEXT,
      source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'slack',
      slack_permalink TEXT,
      thread_ts TEXT,
      reply_count INTEGER NOT NULL DEFAULT 0,
      author_id TEXT,
      author_name TEXT,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_message TEXT NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      live_received_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (slack_channel_id, alert_number)
    );

    CREATE TABLE IF NOT EXISTS slack_alert_extraction_state (
      slack_channel_id TEXT PRIMARY KEY,
      slack_channel_name TEXT,
      workspace_name TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      pages_scanned INTEGER NOT NULL DEFAULT 0,
      messages_scanned INTEGER NOT NULL DEFAULT 0,
      alert_messages_detected INTEGER NOT NULL DEFAULT 0,
      unique_alert_numbers INTEGER NOT NULL DEFAULT 0,
      source_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS team TEXT;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS runbook TEXT;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS team TEXT;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS runbook TEXT;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS live_received_at TIMESTAMPTZ;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS slack_event_id TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_received_at TIMESTAMPTZ;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsing_status TEXT NOT NULL DEFAULT 'UNASSESSED';
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_error_code TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_error TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_alert_number TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_alert_name TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_source TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_priority TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_responder TEXT;
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_mode TEXT NOT NULL DEFAULT 'historical';
    ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS archive_scope TEXT NOT NULL DEFAULT 'OPERATIONAL';
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS live_received_at TIMESTAMPTZ;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS live_received_at TIMESTAMPTZ;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS slack_event_id TEXT;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS event_received_at TIMESTAMPTZ;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS frontend_delivered_at TIMESTAMPTZ;
    ALTER TABLE slack_alert_events ADD COLUMN IF NOT EXISTS delivery_mode TEXT;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS slack_event_id TEXT;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS event_received_at TIMESTAMPTZ;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS frontend_delivered_at TIMESTAMPTZ;
    ALTER TABLE slack_normalized_alerts ADD COLUMN IF NOT EXISTS delivery_mode TEXT;

    CREATE TABLE IF NOT EXISTS slack_alert_live_sync_state (
      slack_channel_id TEXT PRIMARY KEY,
      slack_channel_name TEXT,
      workspace_name TEXT,
      connected BOOLEAN NOT NULL DEFAULT FALSE,
      poll_status TEXT NOT NULL DEFAULT 'idle',
      poll_interval_seconds INTEGER NOT NULL DEFAULT 30,
      last_processed_ts TEXT,
      last_fetch_started_at TIMESTAMPTZ,
      last_fetch_at TIMESTAMPTZ,
      last_successful_fetch_at TIMESTAMPTZ,
      last_message_at TIMESTAMPTZ,
      last_alert_at TIMESTAMPTZ,
      messages_processed BIGINT NOT NULL DEFAULT 0,
      alerts_detected BIGINT NOT NULL DEFAULT 0,
      last_batch_messages INTEGER NOT NULL DEFAULT 0,
      last_batch_alerts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS slack_event_stream_state (
      slack_channel_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'awaiting_configuration',
      last_event_received_at TIMESTAMPTZ,
      last_alert_received_at TIMESTAMPTZ,
      last_normalized_at TIMESTAMPTZ,
      last_frontend_delivered_at TIMESTAMPTZ,
      last_event_id TEXT,
      events_received BIGINT NOT NULL DEFAULT 0,
      alert_events_received BIGINT NOT NULL DEFAULT 0,
      duplicate_events BIGINT NOT NULL DEFAULT 0,
      last_detection_latency_ms INTEGER,
      last_delivery_latency_ms INTEGER,
      last_error_code TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS slack_ingestion_cycles (
      cycle_id TEXT PRIMARY KEY,
      slack_channel_id TEXT NOT NULL,
      ingestion_mode TEXT NOT NULL,
      archive_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'running',
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      messages_found INTEGER NOT NULL DEFAULT 0,
      raw_messages_stored INTEGER NOT NULL DEFAULT 0,
      alerts_stored INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      parse_failures INTEGER NOT NULL DEFAULT 0,
      permission_failures INTEGER NOT NULL DEFAULT 0,
      missing_records INTEGER NOT NULL DEFAULT 0,
      last_successful_cursor TEXT,
      safe_error_code TEXT,
      safe_error TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS slack_ingestion_errors (
      ingestion_error_id BIGSERIAL PRIMARY KEY,
      slack_event_id TEXT,
      slack_channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      parsing_status TEXT NOT NULL,
      error_code TEXT NOT NULL,
      safe_error TEXT NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (slack_channel_id, message_ts)
    );

    CREATE INDEX IF NOT EXISTS idx_slack_raw_messages_time
      ON slack_raw_messages(slack_channel_id, message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_number
      ON slack_alert_events(slack_channel_id, alert_number);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_time
      ON slack_alert_events(message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_alert_time
      ON slack_alert_events(alert_id, message_at DESC)
      WHERE alert_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_history_time
      ON slack_alert_events(message_at DESC, source_message_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_source_time
      ON slack_alert_events(LOWER(source_system), message_at DESC, source_message_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_priority_time
      ON slack_alert_events(LOWER(COALESCE(priority, '')), message_at DESC, source_message_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_status_time
      ON slack_alert_events(LOWER(COALESCE(status, '')), message_at DESC, source_message_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_responder_time
      ON slack_alert_events(LOWER(BTRIM(COALESCE(responder, team, ''))), message_at DESC, source_message_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_environment_time
      ON slack_alert_events(LOWER(COALESCE(environment, '')), message_at DESC, source_message_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_search
      ON slack_alert_events USING GIN (to_tsvector(
        'simple',
        COALESCE(alert_number, '') || ' ' || COALESCE(title, '') || ' ' ||
        COALESCE(raw_message, '') || ' ' || COALESCE(responder, team, '') || ' ' ||
        COALESCE(service, '') || ' ' || COALESCE(application, '')
      ));
    CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_time
      ON slack_normalized_alerts(last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_source
      ON slack_normalized_alerts(source_system);
    CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_severity
      ON slack_normalized_alerts(severity);
    CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_alert_number_last_seen
      ON slack_normalized_alerts(alert_number, last_seen DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_command_center
      ON slack_normalized_alerts(alert_number)
      WHERE LOWER(BTRIM(COALESCE(responder, team, ''))) = 'command center';
    CREATE INDEX IF NOT EXISTS idx_slack_raw_messages_live_received
      ON slack_raw_messages(live_received_at DESC)
      WHERE live_received_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_live_received
      ON slack_normalized_alerts(live_received_at DESC)
      WHERE live_received_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_slack_alert_events_event_id
      ON slack_alert_events(slack_event_id)
      WHERE slack_event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_raw_messages_event_id_unique
      ON slack_raw_messages(slack_event_id)
      WHERE slack_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_slack_raw_messages_parsing_status
      ON slack_raw_messages(slack_channel_id, parsing_status, message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_slack_ingestion_cycles_channel_time
      ON slack_ingestion_cycles(slack_channel_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_ingestion_errors_event_id_unique
      ON slack_ingestion_errors(slack_event_id)
      WHERE slack_event_id IS NOT NULL;
  `);

  storageEnsured = true;
}

function toRawRow(record, liveReceivedAt = null, ingestion = {}) {
  return {
    slack_channel_id: record.slackChannelId,
    message_ts: record.messageTs,
    slack_channel_name: record.slackChannelName,
    thread_ts: record.threadTs,
    parent_message_ts: record.parentMessageTs,
    message_type: record.messageType,
    author_id: record.authorId,
    author_name: record.authorName,
    message_text: record.text,
    complete_text: record.completeText,
    message_at: record.messageAt,
    reply_count: record.replyCount,
    reactions: record.reactions,
    links: record.links,
    permalink: record.permalink,
    raw_payload: record.rawPayload,
    slack_event_id: ingestion.slackEventId || null,
    ingestion_received_at: ingestion.receivedAt || null,
    parsing_status: ingestion.parsingStatus || 'UNASSESSED',
    ingestion_error_code: ingestion.errorCode || null,
    ingestion_error: ingestion.safeError || null,
    parsed_alert_number: ingestion.alert?.alertNumber || null,
    parsed_alert_name: ingestion.alert?.title || null,
    parsed_source: ingestion.alert?.sourceSystem || null,
    parsed_priority: ingestion.alert?.priority || null,
    parsed_responder: ingestion.alert?.responder || ingestion.alert?.team || null,
    ingestion_mode: ingestion.ingestionMode || 'historical',
    archive_scope: ingestion.archiveScope || 'OPERATIONAL',
    live_received_at: liveReceivedAt,
  };
}

function toAlertEventRow(alert, liveReceivedAt = null, deliveryMetadata = {}) {
  return {
    slack_channel_id: alert.slackChannelId,
    source_message_ts: alert.sourceMessageTs,
    alert_id: alert.alertId,
    alert_number: alert.alertNumber,
    slack_channel_name: alert.slackChannelName,
    title: alert.title,
    source_system: alert.sourceSystem,
    severity: alert.severity,
    priority: alert.priority,
    service: alert.service,
    application: alert.application,
    environment: alert.environment,
    tier: alert.tier,
    team: alert.team,
    responder: alert.responder,
    status: alert.status,
    tags: alert.tags,
    description: alert.description,
    runbook: alert.runbook,
    source_metadata: alert.sourceDetails,
    message_at: alert.firstSeen,
    slack_permalink: alert.slackPermalink,
    thread_ts: alert.threadTs,
    reply_count: alert.replyCount,
    author_id: alert.authorId,
    author_name: alert.authorName,
    links: alert.links,
    raw_message: alert.rawMessage,
    raw_payload: alert.rawPayload,
    live_received_at: liveReceivedAt,
    slack_event_id: deliveryMetadata.slackEventId || null,
    event_received_at: deliveryMetadata.eventReceivedAt || null,
    normalized_at: deliveryMetadata.normalizedAt || null,
    frontend_delivered_at: deliveryMetadata.frontendDeliveredAt || null,
    delivery_mode: deliveryMetadata.deliveryMode || null,
  };
}

async function storePage(messages, context) {
  if (!messages.length) {
    return {
      alertMessages: 0,
      latestAlertAt: null,
      latestMessageAt: null,
      latestMessageTs: null,
      newAlertMessages: 0,
      newRawMessages: 0,
      duplicateMessages: 0,
      newOccurrenceIds: [],
      parseFailures: 0,
      rawMessages: 0,
    };
  }

  const normalizationContext = {
    channel: context.channel,
    workspaceUrl: context.connection?.workspace?.url,
  };
  const liveReceivedAt = ['event', 'live'].includes(context.ingestionMode)
    ? context.receivedAt || new Date().toISOString()
    : null;
  const deliveryMetadata = {
    deliveryMode: context.deliveryMode || (context.ingestionMode === 'event' ? 'slack_events_api' : null),
    eventReceivedAt: context.eventReceivedAt || null,
    frontendDeliveredAt: context.frontendDeliveredAt || null,
    normalizedAt: context.normalizedAt || null,
    slackEventId: context.slackEventId || null,
  };
  const evidenceCollectionMode = getEvidenceCollectionMode();
  const ingestionReceivedAt = context.receivedAt || new Date().toISOString();
  const normalized = messages.map((message) => {
    let record;
    let alert = null;
    let errorCode = null;
    let safeError = null;

    try {
      record = normalizeSlackRecord(message, normalizationContext);
    } catch (error) {
      errorCode = 'SLACK_RAW_NORMALIZATION_FAILED';
      safeError = 'Slack message could not be normalized; the original payload was retained.';
      record = {
        slackChannelId: message?.channel || normalizationContext.channel?.id || null,
        slackChannelName: normalizationContext.channel?.name || null,
        messageTs: message?.ts || null,
        threadTs: message?.thread_ts || null,
        parentMessageTs: null,
        messageType: message?.subtype || 'message',
        authorId: message?.user || message?.bot_id || null,
        authorName: message?.username || message?.bot_profile?.name || null,
        text: message?.text || '',
        completeText: getCompleteMessageText(message),
        messageAt: message?.ts ? new Date(Number.parseFloat(message.ts) * 1000).toISOString() : null,
        replyCount: Number(message?.reply_count || 0),
        reactions: Array.isArray(message?.reactions) ? message.reactions : [],
        links: [],
        permalink: null,
        rawPayload: message || {},
      };
    }

    if (!errorCode) {
      try {
        alert = normalizeSlackAlert(message, normalizationContext);
        if (!alert && isPotentialAlertMessage(message)) {
          errorCode = 'SLACK_ALERT_PARSE_FAILED';
          safeError = 'Message appears to describe an alert but no canonical alert number could be parsed.';
        }
      } catch (error) {
        errorCode = 'SLACK_ALERT_PARSE_FAILED';
        safeError = 'Slack alert parsing failed; the original payload was retained.';
      }
    }

    const parsingStatus = alert
      ? 'PARSED'
      : errorCode
        ? 'PARSE_FAILED'
        : 'NOT_ALERT';

    return {
      alert,
      rawRow: toRawRow(record, liveReceivedAt, {
        alert,
        archiveScope: evidenceCollectionMode.enabled ? 'PERMANENT' : 'OPERATIONAL',
        errorCode,
        ingestionMode: context.ingestionMode || 'historical',
        parsingStatus,
        receivedAt: ingestionReceivedAt,
        safeError,
        slackEventId: deliveryMetadata.slackEventId,
      }),
    };
  });
  const rawRows = normalized
    .map((entry) => entry.rawRow)
    .filter((record) => record.slack_channel_id && record.message_ts);
  const alertRows = normalized
    .map((entry) => entry.alert)
    .filter(Boolean)
    .map((alert) => toAlertEventRow(alert, liveReceivedAt, deliveryMetadata));
  const errorRows = rawRows.filter((row) => row.parsing_status === 'PARSE_FAILED');
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');
    const unseenRawResult = await client.query(
      `
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
            slack_channel_id TEXT,
            message_ts TEXT
          )
        )
        SELECT COUNT(*)::integer AS count
        FROM incoming
        LEFT JOIN slack_raw_messages AS existing
          ON existing.slack_channel_id = incoming.slack_channel_id
          AND existing.message_ts = incoming.message_ts
        WHERE existing.message_ts IS NULL
      `,
      [JSON.stringify(rawRows)],
    );
    const unseenAlertResult = alertRows.length > 0
      ? await client.query(
        `
          WITH incoming AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
              slack_channel_id TEXT,
              source_message_ts TEXT
            )
          )
          SELECT incoming.slack_channel_id, incoming.source_message_ts
          FROM incoming
          LEFT JOIN slack_alert_events AS existing
            ON existing.slack_channel_id = incoming.slack_channel_id
            AND existing.source_message_ts = incoming.source_message_ts
          WHERE existing.source_message_ts IS NULL
        `,
        [JSON.stringify(alertRows)],
      )
      : { rowCount: 0, rows: [] };
    await client.query(
      `
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
            slack_channel_id TEXT,
            message_ts TEXT,
            slack_channel_name TEXT,
            thread_ts TEXT,
            parent_message_ts TEXT,
            message_type TEXT,
            author_id TEXT,
            author_name TEXT,
            message_text TEXT,
            complete_text TEXT,
            message_at TIMESTAMPTZ,
            reply_count INTEGER,
            reactions JSONB,
            links JSONB,
            permalink TEXT,
            raw_payload JSONB,
            slack_event_id TEXT,
            ingestion_received_at TIMESTAMPTZ,
            parsing_status TEXT,
            ingestion_error_code TEXT,
            ingestion_error TEXT,
            parsed_alert_number TEXT,
            parsed_alert_name TEXT,
            parsed_source TEXT,
            parsed_priority TEXT,
            parsed_responder TEXT,
            ingestion_mode TEXT,
            archive_scope TEXT,
            live_received_at TIMESTAMPTZ
          )
        )
        INSERT INTO slack_raw_messages (
          slack_channel_id, message_ts, slack_channel_name, thread_ts,
          parent_message_ts, message_type, author_id, author_name,
          message_text, complete_text, message_at, reply_count, reactions,
          links, permalink, raw_payload, slack_event_id,
          ingestion_received_at, parsing_status, ingestion_error_code,
          ingestion_error, parsed_alert_number, parsed_alert_name,
          parsed_source, parsed_priority, parsed_responder, ingestion_mode,
          archive_scope, live_received_at
        )
        SELECT
          slack_channel_id, message_ts, slack_channel_name, thread_ts,
          parent_message_ts, message_type, author_id, author_name,
          message_text, complete_text, message_at, reply_count,
          COALESCE(reactions, '[]'::jsonb), COALESCE(links, '[]'::jsonb),
          permalink, COALESCE(raw_payload, '{}'::jsonb), slack_event_id,
          ingestion_received_at, COALESCE(parsing_status, 'UNASSESSED'),
          ingestion_error_code, ingestion_error, parsed_alert_number,
          parsed_alert_name, parsed_source, parsed_priority, parsed_responder,
          COALESCE(ingestion_mode, 'historical'),
          COALESCE(archive_scope, 'OPERATIONAL'), live_received_at
        FROM incoming
        ON CONFLICT (slack_channel_id, message_ts)
        DO UPDATE SET
          slack_channel_name = EXCLUDED.slack_channel_name,
          thread_ts = EXCLUDED.thread_ts,
          parent_message_ts = EXCLUDED.parent_message_ts,
          message_type = EXCLUDED.message_type,
          author_id = EXCLUDED.author_id,
          author_name = EXCLUDED.author_name,
          message_text = COALESCE(slack_raw_messages.message_text, EXCLUDED.message_text),
          complete_text = COALESCE(slack_raw_messages.complete_text, EXCLUDED.complete_text),
          message_at = COALESCE(slack_raw_messages.message_at, EXCLUDED.message_at),
          reply_count = GREATEST(slack_raw_messages.reply_count, EXCLUDED.reply_count),
          reactions = CASE WHEN jsonb_array_length(slack_raw_messages.reactions) = 0 THEN EXCLUDED.reactions ELSE slack_raw_messages.reactions END,
          links = CASE WHEN jsonb_array_length(slack_raw_messages.links) = 0 THEN EXCLUDED.links ELSE slack_raw_messages.links END,
          permalink = COALESCE(slack_raw_messages.permalink, EXCLUDED.permalink),
          slack_event_id = COALESCE(slack_raw_messages.slack_event_id, EXCLUDED.slack_event_id),
          ingestion_received_at = COALESCE(slack_raw_messages.ingestion_received_at, EXCLUDED.ingestion_received_at),
          parsing_status = CASE
            WHEN EXCLUDED.parsing_status = 'PARSED' THEN 'PARSED'
            WHEN slack_raw_messages.parsing_status = 'UNASSESSED' THEN EXCLUDED.parsing_status
            ELSE slack_raw_messages.parsing_status
          END,
          ingestion_error_code = COALESCE(slack_raw_messages.ingestion_error_code, EXCLUDED.ingestion_error_code),
          ingestion_error = COALESCE(slack_raw_messages.ingestion_error, EXCLUDED.ingestion_error),
          parsed_alert_number = COALESCE(slack_raw_messages.parsed_alert_number, EXCLUDED.parsed_alert_number),
          parsed_alert_name = COALESCE(slack_raw_messages.parsed_alert_name, EXCLUDED.parsed_alert_name),
          parsed_source = COALESCE(slack_raw_messages.parsed_source, EXCLUDED.parsed_source),
          parsed_priority = COALESCE(slack_raw_messages.parsed_priority, EXCLUDED.parsed_priority),
          parsed_responder = COALESCE(slack_raw_messages.parsed_responder, EXCLUDED.parsed_responder),
          ingestion_mode = COALESCE(slack_raw_messages.ingestion_mode, EXCLUDED.ingestion_mode),
          archive_scope = CASE WHEN slack_raw_messages.archive_scope = 'PERMANENT' THEN 'PERMANENT' ELSE EXCLUDED.archive_scope END,
          live_received_at = COALESCE(slack_raw_messages.live_received_at, EXCLUDED.live_received_at),
          updated_at = NOW()
      `,
      [JSON.stringify(rawRows)],
    );

    if (alertRows.length > 0) {
      await client.query(
        `
          WITH incoming AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
              slack_channel_id TEXT,
              source_message_ts TEXT,
              alert_id TEXT,
              alert_number TEXT,
              slack_channel_name TEXT,
              title TEXT,
              source_system TEXT,
              severity TEXT,
              priority TEXT,
              service TEXT,
              application TEXT,
              environment TEXT,
              tier TEXT,
              team TEXT,
              responder TEXT,
              status TEXT,
              tags JSONB,
              description TEXT,
              runbook TEXT,
              source_metadata JSONB,
              message_at TIMESTAMPTZ,
              slack_permalink TEXT,
              thread_ts TEXT,
              reply_count INTEGER,
              author_id TEXT,
              author_name TEXT,
              links JSONB,
              raw_message TEXT,
              raw_payload JSONB,
              live_received_at TIMESTAMPTZ,
              slack_event_id TEXT,
              event_received_at TIMESTAMPTZ,
              normalized_at TIMESTAMPTZ,
              frontend_delivered_at TIMESTAMPTZ,
              delivery_mode TEXT
            )
          )
          INSERT INTO slack_alert_events (
            slack_channel_id, source_message_ts, alert_id, alert_number,
            slack_channel_name, title, source_system, severity, priority,
            service, application, environment, tier, team, responder, status, tags,
            description, runbook, source_metadata, message_at, slack_permalink, thread_ts, reply_count,
            author_id, author_name, links, raw_message, raw_payload, live_received_at,
            slack_event_id, event_received_at, normalized_at, frontend_delivered_at,
            delivery_mode
          )
          SELECT
            slack_channel_id, source_message_ts, alert_id, alert_number,
            slack_channel_name, title, COALESCE(source_system, 'Unknown'), severity,
            priority, service, application, environment, tier, team, responder, status,
            COALESCE(tags, '[]'::jsonb), description, runbook,
            COALESCE(source_metadata, '{}'::jsonb), message_at, slack_permalink,
            thread_ts, reply_count, author_id, author_name,
            COALESCE(links, '[]'::jsonb), raw_message,
            COALESCE(raw_payload, '{}'::jsonb), live_received_at,
            slack_event_id, event_received_at, normalized_at, frontend_delivered_at,
            delivery_mode
          FROM incoming
          ON CONFLICT (slack_channel_id, source_message_ts)
          DO UPDATE SET
            alert_id = EXCLUDED.alert_id,
            alert_number = EXCLUDED.alert_number,
            slack_channel_name = EXCLUDED.slack_channel_name,
            title = EXCLUDED.title,
            source_system = EXCLUDED.source_system,
            severity = EXCLUDED.severity,
            priority = EXCLUDED.priority,
            service = EXCLUDED.service,
            application = EXCLUDED.application,
            environment = EXCLUDED.environment,
            tier = EXCLUDED.tier,
            team = EXCLUDED.team,
            responder = EXCLUDED.responder,
            status = EXCLUDED.status,
            tags = EXCLUDED.tags,
            description = EXCLUDED.description,
            runbook = EXCLUDED.runbook,
            source_metadata = EXCLUDED.source_metadata,
            message_at = EXCLUDED.message_at,
            slack_permalink = EXCLUDED.slack_permalink,
            thread_ts = EXCLUDED.thread_ts,
            reply_count = EXCLUDED.reply_count,
            author_id = EXCLUDED.author_id,
            author_name = EXCLUDED.author_name,
            links = EXCLUDED.links,
            raw_message = EXCLUDED.raw_message,
            raw_payload = EXCLUDED.raw_payload,
            live_received_at = COALESCE(slack_alert_events.live_received_at, EXCLUDED.live_received_at),
            slack_event_id = COALESCE(slack_alert_events.slack_event_id, EXCLUDED.slack_event_id),
            event_received_at = COALESCE(slack_alert_events.event_received_at, EXCLUDED.event_received_at),
            normalized_at = COALESCE(slack_alert_events.normalized_at, EXCLUDED.normalized_at),
            frontend_delivered_at = COALESCE(slack_alert_events.frontend_delivered_at, EXCLUDED.frontend_delivered_at),
            delivery_mode = COALESCE(slack_alert_events.delivery_mode, EXCLUDED.delivery_mode),
            updated_at = NOW()
        `,
        [JSON.stringify(alertRows)],
      );
    }

    if (errorRows.length > 0) {
      await client.query(
        `
          WITH incoming AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
              slack_event_id TEXT,
              slack_channel_id TEXT,
              message_ts TEXT,
              parsing_status TEXT,
              ingestion_error_code TEXT,
              ingestion_error TEXT,
              raw_payload JSONB,
              ingestion_received_at TIMESTAMPTZ
            )
          )
          INSERT INTO slack_ingestion_errors (
            slack_event_id, slack_channel_id, message_ts, parsing_status,
            error_code, safe_error, raw_payload, received_at
          )
          SELECT
            slack_event_id, slack_channel_id, message_ts, parsing_status,
            COALESCE(ingestion_error_code, 'SLACK_ALERT_PARSE_FAILED'),
            COALESCE(ingestion_error, 'Slack alert parsing failed; the original payload was retained.'),
            COALESCE(raw_payload, '{}'::jsonb), ingestion_received_at
          FROM incoming
          ON CONFLICT (slack_channel_id, message_ts) DO NOTHING
        `,
        [JSON.stringify(errorRows)],
      );
    }

    if (alertRows.length > 0 && context.deferNormalized !== true) {
      await upsertNormalizedAlerts(
        client,
        alertRows[0].slack_channel_id,
        [...new Set(alertRows.map((row) => row.alert_number))],
      );
    }

    await client.query('COMMIT');
    const latestRawRow = rawRows.reduce((latest, row) => (
      !latest || Number(row.message_ts) > Number(latest.message_ts) ? row : latest
    ), null);
    const latestAlertRow = alertRows.reduce((latest, row) => (
      !latest || Number(row.source_message_ts) > Number(latest.source_message_ts) ? row : latest
    ), null);
    return {
      alertMessages: alertRows.length,
      latestAlertAt: latestAlertRow?.message_at || null,
      latestMessageAt: latestRawRow?.message_at || null,
      latestMessageTs: latestRawRow?.message_ts || null,
      newAlertMessages: unseenAlertResult.rowCount,
      newOccurrenceIds: unseenAlertResult.rows.map((row) => encodeOccurrenceId(row.slack_channel_id, row.source_message_ts)),
      newRawMessages: Number(unseenRawResult.rows[0]?.count || 0),
      duplicateMessages: Math.max(0, rawRows.length - Number(unseenRawResult.rows[0]?.count || 0)),
      parseFailures: errorRows.length,
      rawMessages: rawRows.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function upsertNormalizedAlerts(client, channelId, alertNumbers = []) {
  if (!channelId || alertNumbers.length === 0) return;

  await client.query(
    `
      WITH ranked AS (
        SELECT
          events.*,
          COUNT(*) OVER alert_group AS grouped_occurrence_count,
          MIN(message_at) OVER alert_group AS grouped_first_seen,
          MAX(message_at) OVER alert_group AS grouped_last_seen,
          MAX(thread_ts) OVER alert_group AS grouped_thread_ts,
          MAX(reply_count) OVER alert_group AS grouped_reply_count,
          MAX(live_received_at) OVER alert_group AS grouped_live_received_at,
          MAX(event_received_at) OVER alert_group AS grouped_event_received_at,
          MAX(normalized_at) OVER alert_group AS grouped_normalized_at,
          MAX(frontend_delivered_at) OVER alert_group AS grouped_frontend_delivered_at,
          FIRST_VALUE(slack_event_id) OVER latest_event AS grouped_slack_event_id,
          FIRST_VALUE(delivery_mode) OVER latest_event AS grouped_delivery_mode,
          ROW_NUMBER() OVER (
            PARTITION BY slack_channel_id, alert_number
            ORDER BY LENGTH(raw_message) DESC, message_at DESC NULLS LAST
          ) AS representative_rank
        FROM slack_alert_events AS events
        WHERE slack_channel_id = $1
          AND alert_number = ANY($2::text[])
        WINDOW
          alert_group AS (PARTITION BY slack_channel_id, alert_number),
          latest_event AS (
            PARTITION BY slack_channel_id, alert_number
            ORDER BY event_received_at DESC NULLS LAST, message_at DESC NULLS LAST
          )
      )
      INSERT INTO slack_normalized_alerts (
        id, slack_channel_id, slack_channel_name, source_message_ts,
        alert_number, title, source_system, severity, priority, service,
        application, environment, tier, team, responder, status, tags, description,
        runbook, source_metadata,
        first_seen, last_seen, occurrence_count, source, slack_permalink,
        thread_ts, reply_count, author_id, author_name, links, raw_message,
        raw_payload, live_received_at, slack_event_id, event_received_at,
        normalized_at, frontend_delivered_at, delivery_mode
      )
      SELECT
        alert_id, slack_channel_id, slack_channel_name, source_message_ts,
        alert_number, title, source_system, severity, priority, service,
        application, environment, tier, team, responder, status, tags, description,
        runbook, source_metadata,
        grouped_first_seen, grouped_last_seen, grouped_occurrence_count,
        'slack', slack_permalink, grouped_thread_ts, grouped_reply_count,
        author_id, author_name, links, raw_message, raw_payload,
        grouped_live_received_at, grouped_slack_event_id, grouped_event_received_at,
        grouped_normalized_at, grouped_frontend_delivered_at, grouped_delivery_mode
      FROM ranked
      WHERE representative_rank = 1
      ON CONFLICT (slack_channel_id, alert_number)
      DO UPDATE SET
        id = EXCLUDED.id,
        slack_channel_name = EXCLUDED.slack_channel_name,
        source_message_ts = EXCLUDED.source_message_ts,
        title = EXCLUDED.title,
        source_system = EXCLUDED.source_system,
        severity = EXCLUDED.severity,
        priority = EXCLUDED.priority,
        service = EXCLUDED.service,
        application = EXCLUDED.application,
        environment = EXCLUDED.environment,
        tier = EXCLUDED.tier,
        team = EXCLUDED.team,
        responder = EXCLUDED.responder,
        status = EXCLUDED.status,
        tags = EXCLUDED.tags,
        description = EXCLUDED.description,
        runbook = EXCLUDED.runbook,
        source_metadata = EXCLUDED.source_metadata,
        first_seen = EXCLUDED.first_seen,
        last_seen = EXCLUDED.last_seen,
        occurrence_count = EXCLUDED.occurrence_count,
        source = EXCLUDED.source,
        slack_permalink = EXCLUDED.slack_permalink,
        thread_ts = EXCLUDED.thread_ts,
        reply_count = EXCLUDED.reply_count,
        author_id = EXCLUDED.author_id,
        author_name = EXCLUDED.author_name,
        links = EXCLUDED.links,
        raw_message = EXCLUDED.raw_message,
        raw_payload = EXCLUDED.raw_payload,
        live_received_at = EXCLUDED.live_received_at,
        slack_event_id = EXCLUDED.slack_event_id,
        event_received_at = EXCLUDED.event_received_at,
        normalized_at = EXCLUDED.normalized_at,
        frontend_delivered_at = EXCLUDED.frontend_delivered_at,
        delivery_mode = EXCLUDED.delivery_mode,
        updated_at = NOW()
    `,
    [channelId, alertNumbers],
  );
}

async function rebuildNormalizedAlerts(channelId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM slack_normalized_alerts WHERE slack_channel_id = $1', [channelId]);
    await client.query(
      `
        WITH ranked AS (
          SELECT
            events.*,
            COUNT(*) OVER alert_group AS grouped_occurrence_count,
            MIN(message_at) OVER alert_group AS grouped_first_seen,
            MAX(message_at) OVER alert_group AS grouped_last_seen,
            MAX(thread_ts) OVER alert_group AS grouped_thread_ts,
            MAX(reply_count) OVER alert_group AS grouped_reply_count,
            MAX(live_received_at) OVER alert_group AS grouped_live_received_at,
            MAX(event_received_at) OVER alert_group AS grouped_event_received_at,
            MAX(normalized_at) OVER alert_group AS grouped_normalized_at,
            MAX(frontend_delivered_at) OVER alert_group AS grouped_frontend_delivered_at,
            FIRST_VALUE(slack_event_id) OVER latest_event AS grouped_slack_event_id,
            FIRST_VALUE(delivery_mode) OVER latest_event AS grouped_delivery_mode,
            ROW_NUMBER() OVER (
              PARTITION BY slack_channel_id, alert_number
              ORDER BY LENGTH(raw_message) DESC, message_at DESC NULLS LAST
            ) AS representative_rank
          FROM slack_alert_events AS events
          WHERE slack_channel_id = $1
          WINDOW
            alert_group AS (PARTITION BY slack_channel_id, alert_number),
            latest_event AS (
              PARTITION BY slack_channel_id, alert_number
              ORDER BY event_received_at DESC NULLS LAST, message_at DESC NULLS LAST
            )
        )
        INSERT INTO slack_normalized_alerts (
          id, slack_channel_id, slack_channel_name, source_message_ts,
          alert_number, title, source_system, severity, priority, service,
          application, environment, tier, team, responder, status, tags, description,
          runbook, source_metadata,
          first_seen, last_seen, occurrence_count, source, slack_permalink,
          thread_ts, reply_count, author_id, author_name, links, raw_message,
          raw_payload, live_received_at, slack_event_id, event_received_at,
          normalized_at, frontend_delivered_at, delivery_mode
        )
        SELECT
          alert_id, slack_channel_id, slack_channel_name, source_message_ts,
          alert_number, title, source_system, severity, priority, service,
          application, environment, tier, team, responder, status, tags, description,
          runbook, source_metadata,
          grouped_first_seen, grouped_last_seen, grouped_occurrence_count,
          'slack', slack_permalink, grouped_thread_ts, grouped_reply_count,
          author_id, author_name, links, raw_message, raw_payload,
          grouped_live_received_at, grouped_slack_event_id, grouped_event_received_at,
          grouped_normalized_at, grouped_frontend_delivered_at, grouped_delivery_mode
        FROM ranked
        WHERE representative_rank = 1
      `,
      [channelId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getSourceCounts(channelId) {
  const result = await db.query(
    `
      SELECT source_system, COUNT(*)::integer AS count
      FROM slack_normalized_alerts
      WHERE slack_channel_id = $1
      GROUP BY source_system
      ORDER BY count DESC, source_system ASC
    `,
    [channelId],
  );
  return Object.fromEntries(result.rows.map((row) => [row.source_system || 'Unknown', Number(row.count || 0)]));
}

async function updateSyncState(channelId, patch = {}) {
  await db.query(
    `
      INSERT INTO slack_alert_extraction_state (
        slack_channel_id, slack_channel_name, workspace_name, status,
        pages_scanned, messages_scanned, alert_messages_detected,
        unique_alert_numbers, source_counts, started_at, completed_at,
        last_error, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,NOW())
      ON CONFLICT (slack_channel_id)
      DO UPDATE SET
        slack_channel_name = COALESCE(EXCLUDED.slack_channel_name, slack_alert_extraction_state.slack_channel_name),
        workspace_name = COALESCE(EXCLUDED.workspace_name, slack_alert_extraction_state.workspace_name),
        status = EXCLUDED.status,
        pages_scanned = EXCLUDED.pages_scanned,
        messages_scanned = EXCLUDED.messages_scanned,
        alert_messages_detected = EXCLUDED.alert_messages_detected,
        unique_alert_numbers = EXCLUDED.unique_alert_numbers,
        source_counts = EXCLUDED.source_counts,
        started_at = COALESCE(EXCLUDED.started_at, slack_alert_extraction_state.started_at),
        completed_at = EXCLUDED.completed_at,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
    `,
    [
      channelId,
      patch.channelName || null,
      patch.workspaceName || null,
      patch.status || 'running',
      Number(patch.pagesScanned || 0),
      Number(patch.messagesScanned || 0),
      Number(patch.alertMessagesDetected || 0),
      Number(patch.uniqueAlertNumbers || 0),
      JSON.stringify(patch.sourceCounts || {}),
      patch.startedAt || null,
      patch.completedAt || null,
      patch.lastError || null,
    ],
  );
}

async function syncFullHistory(options = {}) {
  if (syncInProgress) {
    const error = new Error('A Slack alert extraction sync is already running.');
    error.code = 'SLACK_ALERT_SYNC_IN_PROGRESS';
    error.status = 409;
    throw error;
  }

  await ensureStorage();
  syncInProgress = true;
  const startedAt = new Date().toISOString();
  let pagesScanned = 0;
  let messagesScanned = 0;
  let alertMessagesDetected = 0;
  let activeChannelId = null;

  try {
    const scan = await slackIngestionService.scanChannelHistory({
      collectMessages: false,
      limit: options.pageSize || 100,
      maxPages: options.maxPages || 'all',
      onPage: async (messages, progress) => {
        activeChannelId = progress.channel.id;
        const stored = await storePage(messages, { ...progress, deferNormalized: true });
        pagesScanned = progress.page;
        messagesScanned = progress.recordsRetrieved;
        alertMessagesDetected += stored.alertMessages;
        await updateSyncState(activeChannelId, {
          alertMessagesDetected,
          channelName: progress.channel.name,
          messagesScanned,
          pagesScanned,
          startedAt,
          status: 'running',
          workspaceName: progress.connection.workspace.name,
        });
        if (typeof options.onProgress === 'function') {
          options.onProgress({ alertMessagesDetected, messagesScanned, pagesScanned });
        }
      },
    });

    activeChannelId = scan.channel.id;
    await rebuildNormalizedAlerts(activeChannelId);
    const countsResult = await db.query(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM slack_raw_messages WHERE slack_channel_id = $1) AS raw_messages_stored,
          (SELECT COUNT(*)::integer FROM slack_alert_events WHERE slack_channel_id = $1) AS alert_messages_stored,
          (SELECT COUNT(*)::integer FROM slack_normalized_alerts WHERE slack_channel_id = $1) AS unique_alert_numbers
      `,
      [activeChannelId],
    );
    const counts = countsResult.rows[0];
    const sourceCounts = await getSourceCounts(activeChannelId);
    const completedAt = new Date().toISOString();
    const result = {
      alertMessagesDetected: Number(counts.alert_messages_stored || alertMessagesDetected),
      channelId: activeChannelId,
      channelName: scan.channel.name,
      complete: !scan.history.truncated,
      completedAt,
      messagesScanned,
      pagesScanned,
      rawMessagesStored: Number(counts.raw_messages_stored || 0),
      sourceCounts,
      startedAt,
      uniqueAlertNumbers: Number(counts.unique_alert_numbers || 0),
      workspaceName: scan.connection.workspace.name,
    };
    await updateSyncState(activeChannelId, {
      ...result,
      status: result.complete ? 'complete' : 'partial',
    });
    return result;
  } catch (error) {
    if (activeChannelId) {
      await updateSyncState(activeChannelId, {
        alertMessagesDetected,
        completedAt: new Date().toISOString(),
        lastError: error.safeMessage || error.message,
        messagesScanned,
        pagesScanned,
        startedAt,
        status: 'failed',
      }).catch(() => {});
    }
    throw error;
  } finally {
    syncInProgress = false;
  }
}

async function refreshFromStoredRaw(options = {}) {
  await ensureStorage();
  const batchSize = Math.min(Math.max(Number(options.batchSize || 1000), 100), 5000);
  const alertsOnly = options.alertsOnly !== false;
  const stateResult = await db.query(
    'SELECT * FROM slack_alert_extraction_state ORDER BY updated_at DESC LIMIT 1',
  );
  const state = stateResult.rows[0];

  if (!state?.slack_channel_id) {
    const error = new Error('No completed Slack history extraction is available to refresh.');
    error.code = 'SLACK_ALERT_EXTRACTION_NOT_FOUND';
    error.status = 404;
    throw error;
  }

  const channelId = state.slack_channel_id;
  const metadataResult = await db.query(
    alertsOnly
      ? `
          SELECT
            COUNT(*)::integer AS total,
            MIN(regexp_replace(raw.permalink, '/archives/.*$', '')) FILTER (WHERE raw.permalink IS NOT NULL) AS workspace_url
          FROM slack_raw_messages AS raw
          INNER JOIN slack_alert_events AS event
            ON event.slack_channel_id = raw.slack_channel_id
            AND event.source_message_ts = raw.message_ts
          WHERE raw.slack_channel_id = $1
        `
      : `
          SELECT
            COUNT(*)::integer AS total,
            MIN(regexp_replace(permalink, '/archives/.*$', '')) FILTER (WHERE permalink IS NOT NULL) AS workspace_url
          FROM slack_raw_messages
          WHERE slack_channel_id = $1
        `,
    [channelId],
  );
  const total = Number(metadataResult.rows[0]?.total || 0);
  const context = {
    channel: { id: channelId, name: state.slack_channel_name || null },
    connection: { workspace: { url: metadataResult.rows[0]?.workspace_url || null } },
  };
  let processed = 0;

  while (processed < total) {
    const page = await db.query(
      alertsOnly
        ? `
            SELECT raw.raw_payload
            FROM slack_raw_messages AS raw
            INNER JOIN slack_alert_events AS event
              ON event.slack_channel_id = raw.slack_channel_id
              AND event.source_message_ts = raw.message_ts
            WHERE raw.slack_channel_id = $1
            ORDER BY raw.message_at DESC NULLS LAST, raw.message_ts DESC
            LIMIT $2 OFFSET $3
          `
        : `
            SELECT raw_payload
            FROM slack_raw_messages
            WHERE slack_channel_id = $1
            ORDER BY message_at DESC NULLS LAST, message_ts DESC
            LIMIT $2 OFFSET $3
          `,
      [channelId, batchSize, processed],
    );
    if (!page.rows.length) break;
    await storePage(page.rows.map((row) => row.raw_payload), { ...context, deferNormalized: true });
    processed += page.rows.length;
    if (typeof options.onProgress === 'function') options.onProgress({ processed, total });
  }

  await rebuildNormalizedAlerts(channelId);
  const sourceCounts = await getSourceCounts(channelId);
  const countsResult = await db.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM slack_alert_events WHERE slack_channel_id = $1) AS alert_messages_detected,
        (SELECT COUNT(*)::integer FROM slack_normalized_alerts WHERE slack_channel_id = $1) AS unique_alert_numbers
    `,
    [channelId],
  );

  return {
    alertMessagesDetected: Number(countsResult.rows[0]?.alert_messages_detected || 0),
    alertsOnly,
    channelId,
    messagesProcessed: processed,
    sourceCounts,
    uniqueAlertNumbers: Number(countsResult.rows[0]?.unique_alert_numbers || 0),
  };
}

function laterSlackTimestamp(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Number(right) > Number(left) ? right : left;
}

function laterIsoTimestamp(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(right).getTime() > new Date(left).getTime() ? right : left;
}

async function initializeLiveSyncState(channelId, config) {
  const historicalResult = await db.query(
    `
      SELECT slack_channel_name, workspace_name
      FROM slack_alert_extraction_state
      WHERE slack_channel_id = $1
      LIMIT 1
    `,
    [channelId],
  );
  const cursorResult = await db.query(
    `
      SELECT message_ts, message_at
      FROM slack_raw_messages
      WHERE slack_channel_id = $1
      ORDER BY message_at DESC NULLS LAST, message_ts DESC
      LIMIT 1
    `,
    [channelId],
  );
  const alertResult = await db.query(
    `
      SELECT message_at
      FROM slack_alert_events
      WHERE slack_channel_id = $1
      ORDER BY message_at DESC NULLS LAST, source_message_ts DESC
      LIMIT 1
    `,
    [channelId],
  );
  const historical = historicalResult.rows[0] || {};
  const latestMessage = cursorResult.rows[0] || {};
  const latestAlert = alertResult.rows[0] || {};

  await db.query(
    `
      INSERT INTO slack_alert_live_sync_state (
        slack_channel_id, slack_channel_name, workspace_name,
        poll_interval_seconds, last_processed_ts, last_message_at,
        last_alert_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (slack_channel_id)
      DO UPDATE SET
        slack_channel_name = COALESCE(slack_alert_live_sync_state.slack_channel_name, EXCLUDED.slack_channel_name),
        workspace_name = COALESCE(slack_alert_live_sync_state.workspace_name, EXCLUDED.workspace_name),
        poll_interval_seconds = EXCLUDED.poll_interval_seconds,
        last_processed_ts = COALESCE(slack_alert_live_sync_state.last_processed_ts, EXCLUDED.last_processed_ts),
        last_message_at = COALESCE(slack_alert_live_sync_state.last_message_at, EXCLUDED.last_message_at),
        last_alert_at = COALESCE(slack_alert_live_sync_state.last_alert_at, EXCLUDED.last_alert_at),
        updated_at = NOW()
    `,
    [
      channelId,
      historical.slack_channel_name || null,
      historical.workspace_name || null,
      config.pollIntervalSeconds,
      latestMessage.message_ts || null,
      latestMessage.message_at || null,
      latestAlert.message_at || null,
    ],
  );

  const stateResult = await db.query(
    'SELECT * FROM slack_alert_live_sync_state WHERE slack_channel_id = $1',
    [channelId],
  );
  return stateResult.rows[0];
}

async function markLivePollStarted(channelId, startedAt, config) {
  await db.query(
    `
      UPDATE slack_alert_live_sync_state
      SET poll_status = 'polling',
          poll_interval_seconds = $3,
          last_fetch_started_at = $2,
          updated_at = NOW()
      WHERE slack_channel_id = $1
    `,
    [channelId, startedAt, config.pollIntervalSeconds],
  );
}

async function markLivePollSucceeded(channelId, result) {
  await db.query(
    `
      UPDATE slack_alert_live_sync_state
      SET connected = TRUE,
          poll_status = 'connected',
          slack_channel_name = COALESCE($2, slack_channel_name),
          workspace_name = COALESCE($3, workspace_name),
          last_processed_ts = COALESCE($4, last_processed_ts),
          last_fetch_at = $5,
          last_successful_fetch_at = $5,
          last_message_at = COALESCE($6, last_message_at),
          last_alert_at = COALESCE($7, last_alert_at),
          messages_processed = messages_processed + $8,
          alerts_detected = alerts_detected + $9,
          last_batch_messages = $8,
          last_batch_alerts = $9,
          last_error_code = NULL,
          last_error = NULL,
          updated_at = NOW()
      WHERE slack_channel_id = $1
    `,
    [
      channelId,
      result.channelName || null,
      result.workspaceName || null,
      result.lastProcessedTs || null,
      result.completedAt,
      result.lastMessageAt || null,
      result.lastAlertAt || null,
      result.newMessages,
      result.newAlerts,
    ],
  );
}

async function markLivePollFailed(channelId, error, completedAt) {
  await db.query(
    `
      UPDATE slack_alert_live_sync_state
      SET connected = FALSE,
          poll_status = 'disconnected',
          last_fetch_at = $2,
          last_batch_messages = 0,
          last_batch_alerts = 0,
          last_error_code = $3,
          last_error = $4,
          updated_at = NOW()
      WHERE slack_channel_id = $1
    `,
    [
      channelId,
      completedAt,
      error.code || 'SLACK_INCREMENTAL_SYNC_FAILED',
      error.safeMessage || error.message || 'Slack incremental sync failed.',
    ],
  );
}

async function startIngestionCycle(channelId, ingestionMode, startedAt) {
  const cycleId = crypto.randomUUID();
  await db.query(
    `
      INSERT INTO slack_ingestion_cycles (
        cycle_id, slack_channel_id, ingestion_mode, archive_mode_enabled,
        status, started_at
      ) VALUES ($1,$2,$3,$4,'running',$5)
    `,
    [cycleId, channelId, ingestionMode, getEvidenceCollectionMode().enabled, startedAt],
  );
  return cycleId;
}

async function finishIngestionCycle(cycleId, result = {}, error = null) {
  if (!cycleId) return;
  const permissionFailureCodes = new Set([
    'SLACK_MISSING_SCOPE',
    'SLACK_CHANNEL_ACCESS_DENIED',
    'SLACK_CHANNEL_NOT_FOUND',
    'SLACK_TOKEN_TYPE_NOT_ALLOWED',
  ]);
  await db.query(
    `
      UPDATE slack_ingestion_cycles
      SET status = $2,
          pages_fetched = $3,
          messages_found = $4,
          raw_messages_stored = $5,
          alerts_stored = $6,
          duplicates = $7,
          parse_failures = $8,
          permission_failures = $9,
          missing_records = $10,
          last_successful_cursor = $11,
          safe_error_code = $12,
          safe_error = $13,
          completed_at = $14
      WHERE cycle_id = $1
    `,
    [
      cycleId,
      error ? 'failed' : 'complete',
      Number(result.historyPagesFetched || 0),
      Number(result.recordsRetrieved || 0),
      Number(result.newMessages || 0),
      Number(result.newAlerts || 0),
      Number(result.duplicates || 0),
      Number(result.parseFailures || 0),
      error && permissionFailureCodes.has(error.code) ? 1 : 0,
      Number(result.missingRecords || 0),
      result.lastProcessedTs || null,
      error?.code || null,
      error?.safeMessage || error?.message || null,
      result.completedAt || new Date().toISOString(),
    ],
  );
}

async function syncIncremental(options = {}) {
  if (incrementalSyncInProgress || syncInProgress) {
    return {
      skipped: true,
      reason: incrementalSyncInProgress ? 'incremental_sync_in_progress' : 'historical_sync_in_progress',
    };
  }

  await ensureStorage();
  const slackConfig = slackIngestionService.getSlackConfig();
  const liveConfig = getLiveSyncConfig();
  const channelId = slackConfig.channelId;
  const startedAt = new Date().toISOString();
  let state = await initializeLiveSyncState(channelId, liveConfig);
  let cycleId = null;
  incrementalSyncInProgress = true;

  try {
    cycleId = await startIngestionCycle(channelId, 'incremental_reconciliation', startedAt);
    await markLivePollStarted(channelId, startedAt, liveConfig);

    if (!incrementalSlackContext || incrementalSlackContext.channel.id !== channelId) {
      const [connection, channel] = await Promise.all([
        slackIngestionService.verifyAuthentication(),
        slackIngestionService.getChannelMetadata(),
      ]);
      incrementalSlackContext = { connection, channel };
    }

    let newMessages = 0;
    let newAlerts = 0;
    let lastProcessedTs = state.last_processed_ts || null;
    let lastMessageAt = null;
    let lastAlertAt = null;
    let duplicateMessages = 0;
    let parseFailures = 0;
    const newOccurrenceIds = [];
    const scan = await slackIngestionService.scanChannelHistory({
      channel: incrementalSlackContext.channel,
      collectMessages: false,
      connection: incrementalSlackContext.connection,
      includePermalinks: false,
      includeThreads: false,
      includeUserProfiles: false,
      inclusive: false,
      limit: options.pageSize || 200,
      maxPages: options.maxPages || 'all',
      oldest: state.last_processed_ts || undefined,
      onPage: async (messages, progress) => {
        const stored = await storePage(messages, {
          ...progress,
          ingestionMode: 'live',
          receivedAt: new Date().toISOString(),
        });
        newMessages += stored.newRawMessages;
        newAlerts += stored.newAlertMessages;
        duplicateMessages += stored.duplicateMessages;
        parseFailures += stored.parseFailures;
        newOccurrenceIds.push(...(stored.newOccurrenceIds || []));
        lastProcessedTs = laterSlackTimestamp(lastProcessedTs, stored.latestMessageTs);
        lastMessageAt = laterIsoTimestamp(lastMessageAt, stored.latestMessageAt);
        lastAlertAt = laterIsoTimestamp(lastAlertAt, stored.latestAlertAt);
      },
    });
    const completedAt = new Date().toISOString();
    const result = {
      channelId,
      channelName: scan.channel.name,
      completedAt,
      historyPagesFetched: scan.history.pagesFetched,
      lastAlertAt,
      lastMessageAt,
      lastProcessedTs,
      newAlerts,
      newMessages,
      newOccurrenceIds,
      duplicates: duplicateMessages,
      parseFailures,
      recordsRetrieved: scan.history.recordsRetrieved,
      skipped: false,
      startedAt,
      workspaceName: scan.connection.workspace.name,
    };
    await markLivePollSucceeded(channelId, result);
    await finishIngestionCycle(cycleId, result);
    return result;
  } catch (error) {
    incrementalSlackContext = null;
    await markLivePollFailed(channelId, error, new Date().toISOString()).catch(() => {});
    await finishIngestionCycle(cycleId, { completedAt: new Date().toISOString() }, error).catch(() => {});
    throw error;
  } finally {
    incrementalSyncInProgress = false;
  }
}

async function getStoredSlackContext(channelId) {
  const result = await db.query(
    `
      SELECT
        state.slack_channel_name,
        state.workspace_name,
        (
          SELECT MIN(regexp_replace(raw.permalink, '/archives/.*$', ''))
          FROM slack_raw_messages AS raw
          WHERE raw.slack_channel_id = $1
            AND raw.permalink IS NOT NULL
        ) AS workspace_url
      FROM slack_alert_extraction_state AS state
      WHERE state.slack_channel_id = $1
      LIMIT 1
    `,
    [channelId],
  );
  const row = result.rows[0] || {};
  return {
    channel: {
      id: channelId,
      name: row.slack_channel_name || null,
    },
    connection: {
      workspace: {
        name: row.workspace_name || null,
        url: row.workspace_url || null,
      },
    },
  };
}

function elapsedMilliseconds(from, to) {
  if (!from || !to) return null;
  const elapsed = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null;
}

async function recordEventStreamOutcome(channelId, outcome = {}) {
  if (!channelId) return;
  await ensureStorage();
  const eventReceivedAt = outcome.eventReceivedAt || new Date().toISOString();
  await db.query(
    `
      INSERT INTO slack_event_stream_state (
        slack_channel_id, status, last_event_received_at,
        last_alert_received_at, last_normalized_at, last_event_id,
        events_received, alert_events_received, duplicate_events,
        last_detection_latency_ms, last_error_code, last_error, updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,NOW()
      )
      ON CONFLICT (slack_channel_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        last_event_received_at = EXCLUDED.last_event_received_at,
        last_alert_received_at = COALESCE(EXCLUDED.last_alert_received_at, slack_event_stream_state.last_alert_received_at),
        last_normalized_at = COALESCE(EXCLUDED.last_normalized_at, slack_event_stream_state.last_normalized_at),
        last_event_id = COALESCE(EXCLUDED.last_event_id, slack_event_stream_state.last_event_id),
        events_received = slack_event_stream_state.events_received + 1,
        alert_events_received = slack_event_stream_state.alert_events_received + EXCLUDED.alert_events_received,
        duplicate_events = slack_event_stream_state.duplicate_events + EXCLUDED.duplicate_events,
        last_detection_latency_ms = COALESCE(EXCLUDED.last_detection_latency_ms, slack_event_stream_state.last_detection_latency_ms),
        last_error_code = EXCLUDED.last_error_code,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
    `,
    [
      channelId,
      outcome.error ? 'degraded' : 'healthy',
      eventReceivedAt,
      outcome.isAlert ? eventReceivedAt : null,
      outcome.normalizedAt || null,
      outcome.slackEventId || null,
      outcome.isAlert ? 1 : 0,
      outcome.duplicate ? 1 : 0,
      outcome.detectionLatencyMs ?? null,
      outcome.error?.code || null,
      outcome.error?.safeMessage || outcome.error?.message || null,
    ],
  );
}

async function ingestSlackEventOnce(message, metadata = {}) {
  await ensureStorage();
  const channelId = message?.channel;
  const messageTs = message?.ts;
  if (!channelId || !messageTs) {
    const error = new Error('Slack message event is missing channel or message timestamp.');
    error.code = 'SLACK_EVENT_INVALID_MESSAGE';
    error.status = 400;
    throw error;
  }

  const context = await getStoredSlackContext(channelId);
  const existingRawResult = await db.query(
    `
      SELECT slack_channel_id, message_ts, parsing_status, parsed_alert_number
      FROM slack_raw_messages
      WHERE (slack_channel_id = $1 AND message_ts = $2)
         OR ($3::text IS NOT NULL AND slack_event_id = $3)
      ORDER BY CASE WHEN slack_channel_id = $1 AND message_ts = $2 THEN 0 ELSE 1 END
      LIMIT 1
    `,
    [channelId, messageTs, metadata.slackEventId || null],
  );
  const existingRaw = existingRawResult.rows[0] || null;
  const normalizedPreview = normalizeSlackAlert(message, {
    channel: context.channel,
    workspaceUrl: context.connection.workspace.url,
  });
  const existingNormalizedResult = normalizedPreview
    ? await db.query('SELECT 1 FROM slack_normalized_alerts WHERE id = $1 LIMIT 1', [normalizedPreview.alertId])
    : { rowCount: 0 };
  const eventReceivedAt = metadata.eventReceivedAt || new Date().toISOString();
  const normalizedAt = new Date().toISOString();

  // Slack retries carry the same event ID. A message is also the same delivery
  // when its channel and timestamp match, regardless of whether polling or the
  // Events API observed it first.
  if (existingRaw
    && (existingRaw.slack_channel_id !== channelId || existingRaw.message_ts !== messageTs)) {
    return {
      alert: null,
      detectionLatencyMs: null,
      duplicate: true,
      eventReceivedAt,
      isAlert: existingRaw.parsing_status === 'PARSED',
      newNormalizedAlert: false,
      normalizedAt,
      slackEventId: metadata.slackEventId || null,
      slackMessageTime: null,
      stored: {
        alertMessages: 0,
        duplicateMessages: 1,
        newAlertMessages: 0,
        newRawMessages: 0,
        parseFailures: 0,
        rawMessages: 0,
      },
    };
  }

  const stored = await storePage([message], {
    ...context,
    deliveryMode: 'slack_events_api',
    eventReceivedAt,
    ingestionMode: 'event',
    normalizedAt,
    receivedAt: eventReceivedAt,
    slackEventId: metadata.slackEventId || null,
  });
  const duplicate = Boolean(existingRaw);
  const occurrenceId = normalizedPreview ? encodeOccurrenceId(channelId, messageTs) : null;
  const alert = occurrenceId ? await getAlertOccurrence(occurrenceId) : null;
  const detectionLatencyMs = elapsedMilliseconds(normalizedPreview?.firstSeen, eventReceivedAt);

  return {
    alert,
    detectionLatencyMs,
    duplicate,
    eventReceivedAt,
    isAlert: Boolean(normalizedPreview),
    newNormalizedAlert: Boolean(normalizedPreview) && existingNormalizedResult.rowCount === 0,
    normalizedAt,
    slackEventId: metadata.slackEventId || null,
    slackMessageTime: normalizedPreview?.firstSeen || null,
    stored,
  };
}

async function ingestSlackEvent(message, metadata = {}) {
  const key = `${message?.channel || 'unknown'}:${message?.ts || metadata.slackEventId || 'unknown'}`;
  const inProgress = eventIngestions.get(key);
  if (inProgress) {
    const result = await inProgress;
    return { ...result, duplicate: true };
  }

  const pending = ingestSlackEventOnce(message, metadata);
  eventIngestions.set(key, pending);
  try {
    return await pending;
  } finally {
    eventIngestions.delete(key);
  }
}

async function recordFrontendDelivery(alertId, deliveredAt = new Date().toISOString()) {
  await ensureStorage();
  const occurrence = decodeOccurrenceId(alertId);
  if (occurrence) {
    const occurrenceResult = await db.query(
      `UPDATE slack_alert_events
       SET frontend_delivered_at=CASE WHEN frontend_delivered_at IS NULL OR frontend_delivered_at < $3::timestamptz
         THEN $3::timestamptz ELSE frontend_delivered_at END, updated_at=NOW()
       WHERE slack_channel_id=$1 AND source_message_ts=$2
       RETURNING slack_channel_id, source_message_ts, slack_event_id, message_at, event_received_at`,
      [occurrence.channelId, occurrence.messageTs, deliveredAt],
    );
    const row = occurrenceResult.rows[0];
    if (!row) return null;
    const deliveryLatencyMs = elapsedMilliseconds(row.message_at, deliveredAt);
    await db.query(`UPDATE slack_event_stream_state SET last_frontend_delivered_at=$2,
      last_delivery_latency_ms=$3, updated_at=NOW() WHERE slack_channel_id=$1`,
    [row.slack_channel_id, deliveredAt, deliveryLatencyMs]);
    return { alertId, deliveredAt, deliveryLatencyMs };
  }
  const alertResult = await db.query(
    `
      UPDATE slack_normalized_alerts
      SET frontend_delivered_at = CASE
            WHEN frontend_delivered_at IS NULL OR frontend_delivered_at < $2::timestamptz THEN $2::timestamptz
            ELSE frontend_delivered_at
          END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING slack_channel_id, source_message_ts, slack_event_id, last_seen, event_received_at
    `,
    [alertId, deliveredAt],
  );
  const row = alertResult.rows[0];
  if (!row) return null;

  await db.query(
    `
      UPDATE slack_alert_events
      SET frontend_delivered_at = CASE
            WHEN frontend_delivered_at IS NULL OR frontend_delivered_at < $3::timestamptz THEN $3::timestamptz
            ELSE frontend_delivered_at
          END,
          updated_at = NOW()
      WHERE slack_channel_id = $1
        AND (
          ($4::text IS NOT NULL AND slack_event_id = $4)
          OR ($4::text IS NULL AND source_message_ts = $2)
        )
    `,
    [row.slack_channel_id, row.source_message_ts, deliveredAt, row.slack_event_id || null],
  );
  const deliveryLatencyMs = elapsedMilliseconds(row.last_seen, deliveredAt);
  await db.query(
    `
      UPDATE slack_event_stream_state
      SET last_frontend_delivered_at = $2,
          last_delivery_latency_ms = $3,
          updated_at = NOW()
      WHERE slack_channel_id = $1
    `,
    [row.slack_channel_id, deliveredAt, deliveryLatencyMs],
  );

  return {
    alertId,
    deliveredAt,
    deliveryLatencyMs,
  };
}

function mapAlertRow(row, options = {}) {
  if (!row) return null;
  const firstSeen = row.first_seen ? new Date(row.first_seen).toISOString() : null;
  const lastSeen = row.last_seen ? new Date(row.last_seen).toISOString() : null;
  const eventReceivedTime = row.event_received_at ? new Date(row.event_received_at).toISOString() : null;
  const normalizedAt = row.normalized_at ? new Date(row.normalized_at).toISOString() : null;
  const frontendDeliveredAt = row.frontend_delivered_at ? new Date(row.frontend_delivered_at).toISOString() : null;
  const detectionLatencyMs = lastSeen && eventReceivedTime
    ? Math.max(0, new Date(eventReceivedTime).getTime() - new Date(lastSeen).getTime())
    : null;
  const deliveryLatencyMs = lastSeen && frontendDeliveredAt
    ? Math.max(0, new Date(frontendDeliveredAt).getTime() - new Date(lastSeen).getTime())
    : null;
  const status = row.status || null;
  const responder = row.responder || null;
  const visibleToCommandCenter = isCommandCenterAlert({ responder, team: row.team });
  return {
    id: row.id,
    alertId: row.id,
    alertNumber: row.alert_number,
    sourceEventId: row.source_message_ts,
    slackEventId: row.slack_event_id || null,
    sourceMessageTs: row.source_message_ts,
    slackChannelId: row.slack_channel_id,
    slackChannelName: row.slack_channel_name,
    title: row.title,
    sourceSystem: row.source_system || 'Unknown',
    sources: [row.source_system || 'Unknown'],
    severity: row.severity,
    priority: row.priority,
    service: row.service,
    application: row.application,
    environment: row.environment,
    tier: row.tier,
    team: row.team,
    responder,
    responderTeam: responder || row.team || null,
    currentOwner: responder || row.team || null,
    commandCenterEligible: visibleToCommandCenter,
    status,
    tags: row.tags || [],
    description: row.description,
    runbook: row.runbook,
    sourceDetails: row.source_metadata || {},
    sourceUrl: row.source_metadata?.sourceUrl
      || (row.links || []).find((link) => link !== row.runbook && /j\.opsg\.in|appdynamics|grafana|nagios|thousandeyes/i.test(link))
      || null,
    firstSeen,
    lastSeen,
    occurrences: Number(row.occurrence_count || 1),
    occurrenceCount: Number(row.occurrence_count || 1),
    source: 'slack',
    slackPermalink: row.slack_permalink,
    threadTs: row.thread_ts,
    relatedSlackThread: row.thread_ts,
    replyCount: Number(row.reply_count || 0),
    author: {
      id: row.author_id || null,
      name: row.author_name || null,
    },
    links: row.links || [],
    acknowledged: String(status || '').toLowerCase() === 'acknowledged',
    acknowledgedBy: String(status || '').toLowerCase() === 'acknowledged' ? responder : null,
    receivedLiveAt: row.live_received_at ? new Date(row.live_received_at).toISOString() : null,
    slackMessageTime: lastSeen,
    eventReceivedTime,
    normalizedAt,
    frontendDeliveredAt,
    detectionLatencyMs,
    deliveryLatencyMs,
    deliveryMode: row.delivery_mode || (row.live_received_at ? 'fallback_poll' : 'historical_backfill'),
    recordOrigin: row.live_received_at ? 'live' : 'historical',
    liveData: true,
    readOnlyActions: true,
    activity: [{
      action: 'extracted',
      event: `Alert #${row.alert_number} extracted from Slack`,
      result: 'stored',
      source: row.delivery_mode === 'slack_events_api'
        ? 'Slack Events API'
        : row.live_received_at
          ? 'Slack fallback reconciliation'
          : 'Slack history extraction',
      time: firstSeen,
      timestamp: firstSeen,
      user: row.author_name || row.author_id || 'Slack',
    }],
    ...(options.includeRawPayload ? {
      message: row.raw_message,
      rawMessage: row.raw_message,
      rawPayload: row.raw_payload,
    } : {}),
  };
}

function encodeOccurrenceId(channelId, messageTs) {
  return Buffer.from(`${channelId}:${messageTs}`, 'utf8').toString('base64url');
}

function decodeOccurrenceId(value) {
  try {
    const decoded = Buffer.from(String(value || ''), 'base64url').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0 || separator === decoded.length - 1) return null;
    return { channelId: decoded.slice(0, separator), messageTs: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function safeIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function cleanOperationalDimension(value) {
  if (value === null || value === undefined) return null;
  const firstLine = String(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || null;
}

function sourceLinks(row) {
  const values = [
    row.source_metadata?.sourceUrl,
    row.source_metadata?.url,
    row.source_metadata?.deepLink,
    ...(Array.isArray(row.links) ? row.links : []),
  ].filter((value) => /^https?:\/\//i.test(String(value || '')));
  const jiraLink = values.find((value) => /(?:jira|atlassian|j\.opsg\.in)/i.test(value)) || null;
  const sourcePattern = row.source_system === 'Grafana' ? /grafana/i
    : row.source_system === 'AppDynamics' ? /appdynamics|appd/i
      : row.source_system === 'Nagios' ? /nagios/i
        : row.source_system === 'ThousandEyes' ? /thousandeyes/i
          : null;
  const monitoringLink = sourcePattern
    ? values.find((value) => sourcePattern.test(value) && value !== jiraLink)
    : values.find((value) => value !== jiraLink);
  return { jiraLink, monitoringLink: monitoringLink || null };
}

function sourceAvailability(row) {
  const snapshot = row.feature_snapshot || {};
  const features = snapshot.features || snapshot.featureVector || snapshot;
  const technical = row.technical_evidence || {};
  const status = String(
    technical.coverage?.sourceStatus
    || technical.coverage?.sourceResolution?.status
    || technical.sourceStatus
    || '',
  ).toUpperCase();
  if (features.source_api_available === true || ['AVAILABLE', 'CONNECTED', 'RESOLVED'].includes(status)) return 'AVAILABLE';
  if (features.source_api_available === false || /UNAVAILABLE|ERROR|TIMEOUT|CIRCUIT|DNS/.test(status)) return 'UNAVAILABLE';
  if (/NOT_CONFIGURED/.test(status)) return 'NOT_CONFIGURED';
  return 'UNABLE_TO_VERIFY';
}

function mapOccurrenceRow(row, options = {}) {
  if (!row) return null;
  const occurrenceId = encodeOccurrenceId(row.slack_channel_id, row.source_message_ts);
  const responder = cleanOperationalDimension(row.responder || row.team);
  const application = cleanOperationalDimension(row.application);
  const commandCenterEligible = isCommandCenterAlert({ responder });
  const timestamp = safeIso(row.message_at);
  const refreshedAt = safeIso(row.evidence_refreshed_at || row.feature_as_of || row.normalized_at || row.updated_at);
  const links = sourceLinks(row);
  const automaticFields = [
    ['Alert number', row.alert_number], ['Alert name', row.title], ['Source', row.source_system],
    ['Priority', row.priority], ['Responder', responder], ['Environment', row.environment],
    ['Current status', row.status], ['Alert timestamp', timestamp], ['Monitoring link', links.monitoringLink],
    ['Jira link', links.jiraLink],
  ];
  const automaticallyCollectedEvidence = automaticFields
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([field, value]) => ({ field, value, provenance: 'Slack source message', sourceTimestamp: timestamp }));
  const completionPercentage = Math.round((automaticallyCollectedEvidence.length / automaticFields.length) * 100);
  const reportCompleteness = String(row.evidence_completeness || '').toUpperCase();
  const humanDecision = String(row.human_decision || '').toUpperCase();
  const outcomeStatus = String(row.operational_outcome || row.evidence_outcome_status || (
    humanDecision === 'INCIDENT' ? 'CONFIRMED_INCIDENT'
      : humanDecision === 'NOISE' ? 'CONFIRMED_NOISE'
        : humanDecision === 'NEEDS_REVIEW' ? 'PENDING_EVIDENCE' : ''
  )).toUpperCase();
  const evidenceStatus = outcomeStatus === 'PENDING_EVIDENCE' ? 'PENDING_EVIDENCE'
    : ['CONFIRMED_INCIDENT', 'CONFIRMED_NOISE'].includes(outcomeStatus) ? outcomeStatus
    : reportCompleteness === 'COMPLETE' ? 'COMPLETE'
      : reportCompleteness === 'PARTIAL' || reportCompleteness === 'MISSING' ? 'PARTIAL'
        : 'NOT_STARTED';
  const systemDecision = String(row.final_decision || '').toUpperCase();
  const classification = outcomeStatus === 'CONFIRMED_INCIDENT' ? 'INCIDENT'
    : outcomeStatus === 'CONFIRMED_NOISE' ? 'NOISE'
      : row.report_id ? 'UNCLASSIFIED'
        : systemDecision === 'INCIDENT' ? 'INCIDENT'
          : systemDecision === 'NOISE' ? 'NOISE'
            : 'UNCLASSIFIED';
  return {
    id: occurrenceId,
    occurrenceId,
    alertId: row.canonical_alert_id || null,
    canonicalAlertId: row.canonical_alert_id || null,
    slackAlertId: row.alert_id,
    alertNumber: row.alert_number,
    title: row.title || `Alert #${row.alert_number}`,
    sourceSystem: row.source_system || 'Unknown',
    priority: row.priority || null,
    severity: row.severity || null,
    responder,
    responderTeam: responder,
    commandCenterEligible,
    evidenceWorkflow: commandCenterEligible ? 'LIVE' : 'BACKFILL',
    environment: row.environment || null,
    service: row.service || null,
    application,
    status: row.status || 'Unknown',
    timestamp,
    firstSeen: timestamp,
    lastSeen: timestamp,
    sourceEventId: row.source_message_ts,
    sourceMessageTs: row.source_message_ts,
    slackEventId: row.slack_event_id || null,
    slackChannelId: row.slack_channel_id,
    slackChannelName: row.slack_channel_name || null,
    slackPermalink: row.slack_permalink || null,
    threadTs: row.thread_ts || row.source_message_ts,
    deliveryMode: row.delivery_mode || (row.live_received_at ? 'fallback_poll' : 'historical_backfill'),
    recordOrigin: row.live_received_at ? 'live' : 'historical',
    currentDecision: classification,
    systemDecision: systemDecision || 'UNCLASSIFIED',
    decisionOrigin: outcomeStatus === 'CONFIRMED_INCIDENT' || outcomeStatus === 'CONFIRMED_NOISE'
      ? 'HUMAN_CONFIRMED'
      : ['INCIDENT', 'NOISE'].includes(systemDecision) ? 'EVIDENCE_EVALUATION' : 'UNCLASSIFIED',
    classification,
    classificationLabel: classification.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase()),
    evaluationId: row.evaluation_id || null,
    evidenceStatus,
    evidenceOutcomeStatus: outcomeStatus || null,
    pendingEvidenceReason: row.pending_evidence_reason || null,
    evidenceCompletionPercentage: reportCompleteness === 'COMPLETE' ? 100
      : reportCompleteness === 'PARTIAL' ? Math.max(1, completionPercentage)
        : completionPercentage,
    automaticallyCollectedEvidence,
    sourceAvailability: sourceAvailability(row),
    evidenceLastRefreshedAt: refreshedAt,
    evidenceProvenance: automaticallyCollectedEvidence.map((item) => ({
      source: item.provenance, field: item.field, sourceTimestamp: item.sourceTimestamp,
    })),
    monitoringLink: links.monitoringLink,
    jiraLink: links.jiraLink,
    evidenceReportId: row.report_id || null,
    evidenceSubmittedAt: safeIso(row.submitted_at),
    readOnlyActions: true,
    ...(options.includeRawPayload ? {
      description: row.description || null,
      sourceDetails: row.source_metadata || {},
      rawMessage: row.raw_message || null,
      rawPayload: row.raw_payload || {},
      links: row.links || [],
    } : {}),
  };
}

function buildOccurrenceFilters(query = {}) {
  const clauses = [];
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };
  if (String(query.search || '').trim()) {
    const value = add(String(query.search).trim());
    clauses.push(`to_tsvector(
      'simple',
      COALESCE(events.alert_number, '') || ' ' || COALESCE(events.title, '') || ' ' ||
      COALESCE(events.raw_message, '') || ' ' || COALESCE(events.responder, events.team, '') || ' ' ||
      COALESCE(events.service, '') || ' ' || COALESCE(events.application, '')
    ) @@ websearch_to_tsquery('simple', ${value})`);
  }
  if (query.source && query.source !== 'all') clauses.push(`LOWER(events.source_system)=${add(String(query.source).toLowerCase())}`);
  if (query.priority && query.priority !== 'all') clauses.push(`LOWER(COALESCE(events.priority,''))=${add(String(query.priority).toLowerCase())}`);
  if (query.status && query.status !== 'all') clauses.push(`LOWER(COALESCE(events.status,''))=${add(String(query.status).toLowerCase())}`);
  if (query.responder && query.responder !== 'all') clauses.push(`LOWER(COALESCE(${RESPONDER_DIMENSION_SQL},''))=${add(String(query.responder).trim().toLowerCase())}`);
  if (query.environment && query.environment !== 'all') clauses.push(`LOWER(COALESCE(events.environment,''))=${add(String(query.environment).toLowerCase())}`);
  if (query.application && query.application !== 'all') clauses.push(`LOWER(COALESCE(${APPLICATION_DIMENSION_SQL},''))=${add(String(query.application).toLowerCase())}`);
  if (query.classification && query.classification !== 'all') {
    const aliases = {
      VERIFIED_INCIDENT: 'INCIDENT', RECOMMENDED_INCIDENT: 'INCIDENT',
      VERIFIED_NOISE: 'NOISE', RECOMMENDED_NOISE: 'NOISE',
      INSUFFICIENT_EVIDENCE: 'UNCLASSIFIED', NEEDS_REVIEW: 'UNCLASSIFIED',
      PENDING_EVIDENCE: 'UNCLASSIFIED', UNKNOWN: 'UNCLASSIFIED',
    };
    const requested = String(query.classification).toUpperCase();
    const desired = add(aliases[requested] || requested);
    clauses.push(`${OCCURRENCE_DECISION_SQL}=${desired}`);
  }
  if (query.evidenceStatus && query.evidenceStatus !== 'all') {
    const desired = add(String(query.evidenceStatus).toUpperCase());
    clauses.push(`COALESCE(latest_report.evidence_status,'NOT_STARTED')=${desired}`);
  }
  if (query.range && query.range !== 'all') {
    const interval = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' }[query.range];
    if (interval) clauses.push(`events.message_at >= NOW() - ${add(interval)}::interval`);
  }
  if (query.from) clauses.push(`events.message_at >= ${add(query.from)}::timestamptz`);
  if (query.to) clauses.push(`events.message_at <= ${add(query.to)}::timestamptz`);
  return { params, whereClause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '' };
}

const RESPONDER_DIMENSION_SQL = "NULLIF(BTRIM(SPLIT_PART(REPLACE(COALESCE(events.responder, events.team, ''), CHR(13), ''), CHR(10), 1)), '')";
const APPLICATION_DIMENSION_SQL = "NULLIF(BTRIM(SPLIT_PART(REPLACE(COALESCE(events.application, ''), CHR(13), ''), CHR(10), 1)), '')";

const OCCURRENCE_DECISION_SQL = `(CASE
  WHEN latest_outcome.operational_outcome='CONFIRMED_INCIDENT' THEN 'INCIDENT'
  WHEN latest_outcome.operational_outcome='CONFIRMED_NOISE' THEN 'NOISE'
  WHEN latest_report.evidence_outcome_status='CONFIRMED_INCIDENT' THEN 'INCIDENT'
  WHEN latest_report.evidence_outcome_status='CONFIRMED_NOISE' THEN 'NOISE'
  WHEN latest_report.report_id IS NOT NULL THEN 'UNCLASSIFIED'
  WHEN latest_evaluation.final_decision='INCIDENT' THEN 'INCIDENT'
  WHEN latest_evaluation.final_decision='NOISE' THEN 'NOISE'
  ELSE 'UNCLASSIFIED'
END)`;

const OCCURRENCE_EVIDENCE_SQL = `(latest_evaluation.evaluation_id IS NOT NULL
  OR latest_report.report_id IS NOT NULL
  OR latest_outcome.operational_outcome IS NOT NULL
  OR latest_refresh.refreshed_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM noise_evidence_packages evidence WHERE evidence.alert_id=canonical.id)
  OR EXISTS (SELECT 1 FROM appdynamics_alert_occurrence_evidence evidence WHERE evidence.alert_id=canonical.id)
  OR EXISTS (SELECT 1 FROM grafana_alert_occurrence_evidence evidence WHERE evidence.alert_id=canonical.id)
  OR EXISTS (SELECT 1 FROM nagios_alert_occurrence_evidence evidence WHERE evidence.alert_id=canonical.id))`;

const OCCURRENCE_FROM_SQL = `
  FROM slack_alert_events events
  LEFT JOIN slack_raw_messages raw
    ON raw.slack_channel_id=events.slack_channel_id AND raw.message_ts=events.source_message_ts
  LEFT JOIN LATERAL (
    SELECT alert.id
    FROM alerts alert
    WHERE alert.atlassian_ops_tiny_id=events.alert_number
    ORDER BY ABS(EXTRACT(EPOCH FROM (alert.received_at-events.message_at))) ASC NULLS LAST, alert.received_at DESC
    LIMIT 1
  ) canonical ON TRUE
  LEFT JOIN LATERAL (
    SELECT evaluation.evaluation_id, evaluation.final_decision, evaluation.feature_as_of,
      evaluation.feature_snapshot, evaluation.technical_evidence
    FROM live_shadow_evaluations evaluation
    WHERE evaluation.alert_id=canonical.id
    ORDER BY evaluation.created_at DESC LIMIT 1
  ) latest_evaluation ON TRUE
  LEFT JOIN LATERAL (
    SELECT outcome.outcome AS operational_outcome, outcome.recorded_at AS outcome_recorded_at
    FROM alert_occurrence_outcomes outcome
    WHERE outcome.alert_id=canonical.id AND outcome.is_current
    ORDER BY outcome.recorded_at DESC, outcome.id DESC LIMIT 1
  ) latest_outcome ON TRUE
  LEFT JOIN LATERAL (
    SELECT report.report_id, report.evidence_completeness, report.human_decision,
      report.evidence_outcome_status, report.pending_evidence_reason,
      report.submitted_at,
      CASE WHEN report.evidence_outcome_status='PENDING_EVIDENCE' THEN 'PENDING_EVIDENCE'
        WHEN report.evidence_outcome_status IN ('CONFIRMED_INCIDENT','CONFIRMED_NOISE')
          THEN report.evidence_outcome_status
        WHEN report.human_decision='NEEDS_REVIEW' THEN 'PENDING_EVIDENCE'
        WHEN report.evidence_completeness='COMPLETE' THEN 'COMPLETE'
        ELSE 'PARTIAL' END AS evidence_status
    FROM incident_verification_reports report
    WHERE report.alert_id=canonical.id
    ORDER BY report.submitted_at DESC LIMIT 1
  ) latest_report ON TRUE
  LEFT JOIN LATERAL (
    SELECT refreshed_at FROM evidence_refresh_events refresh
    WHERE refresh.alert_id=canonical.id ORDER BY refreshed_at DESC LIMIT 1
  ) latest_refresh ON TRUE
`;

async function getAlertOccurrences(query = {}) {
  await ensureStorage();
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const { params, whereClause } = buildOccurrenceFilters(query);
  const requiresJoinedCount = (query.evidenceStatus && query.evidenceStatus !== 'all')
    || (query.classification && query.classification !== 'all');
  const countFrom = requiresJoinedCount
    ? OCCURRENCE_FROM_SQL : 'FROM slack_alert_events events';
  const [countResult, archiveResult] = await Promise.all([
    db.query(`SELECT COUNT(*)::integer AS total ${countFrom} ${whereClause}`, params),
    db.query(`SELECT COUNT(*)::integer AS total, MAX(updated_at) AS updated_at FROM slack_alert_events`),
  ]);
  const total = Number(countResult.rows[0]?.total || 0);
  const archiveTotal = Number(archiveResult.rows[0]?.total || 0);
  const result = await db.query(`
    SELECT events.*, raw.ingestion_received_at, canonical.id AS canonical_alert_id,
      latest_evaluation.*, latest_outcome.*, latest_report.*,
      latest_refresh.refreshed_at AS evidence_refreshed_at
    ${OCCURRENCE_FROM_SQL}
    ${whereClause}
    ORDER BY events.message_at ${query.sort === 'oldest' ? 'ASC' : 'DESC'} NULLS LAST,
      events.source_message_ts ${query.sort === 'oldest' ? 'ASC' : 'DESC'}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, pageSize, (page - 1) * pageSize]);
  const facetQuery = (expression) => db.query(`
    SELECT value, count, COUNT(*) OVER()::integer AS facet_total
    FROM (
      SELECT ${expression} AS value, COUNT(*)::integer AS count
      ${countFrom}
      ${whereClause}
      GROUP BY ${expression}
    ) grouped
    ORDER BY count DESC, value ASC
    LIMIT 100
  `, params);
  const [sourceFacets, priorityFacets, responderFacets, statusFacets, applicationFacets] = await Promise.all([
    facetQuery("COALESCE(source_system,'Unknown')"),
    facetQuery("COALESCE(priority,'Unknown')"),
    facetQuery(`COALESCE(${RESPONDER_DIMENSION_SQL},'Unassigned')`),
    facetQuery("COALESCE(status,'Unknown')"),
    facetQuery(`COALESCE(${APPLICATION_DIMENSION_SQL},'Unknown')`),
  ]);
  const facetItems = (resultSet) => resultSet.rows.map(({ value, count }) => ({ value, count: Number(count || 0) }));
  const facetTotal = (resultSet) => Number(resultSet.rows[0]?.facet_total || 0);
  return {
    items: result.rows.map((row) => mapOccurrenceRow(row)),
    page,
    currentPage: page,
    pageSize,
    total,
    totalCount: archiveTotal,
    filteredCount: total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
    updatedAt: safeIso(archiveResult.rows[0]?.updated_at) || new Date().toISOString(),
    window: query.range && query.range !== 'all' ? query.range : 'all',
    facets: {
      sources: facetItems(sourceFacets), priorities: facetItems(priorityFacets),
      responders: facetItems(responderFacets), statuses: facetItems(statusFacets),
      applications: facetItems(applicationFacets),
    },
    facetTotals: {
      sources: facetTotal(sourceFacets), priorities: facetTotal(priorityFacets),
      responders: facetTotal(responderFacets), statuses: facetTotal(statusFacets),
      applications: facetTotal(applicationFacets),
    },
  };
}

async function getAlertOccurrence(id) {
  await ensureStorage();
  const decoded = decodeOccurrenceId(id);
  if (!decoded) return null;
  const result = await db.query(`
    SELECT events.*, raw.ingestion_received_at, canonical.id AS canonical_alert_id,
      latest_evaluation.*, latest_outcome.*, latest_report.*,
      latest_refresh.refreshed_at AS evidence_refreshed_at
    ${OCCURRENCE_FROM_SQL}
    WHERE events.slack_channel_id=$1 AND events.source_message_ts=$2
    LIMIT 1
  `, [decoded.channelId, decoded.messageTs]);
  return mapOccurrenceRow(result.rows[0], { includeRawPayload: true });
}

function mapSummaryMetrics(row = {}) {
  const total = Number(row.total || 0);
  const incidents = Number(row.incidents || 0);
  const confirmedNoise = Number(row.confirmed_noise || 0);
  const alertsWithEvidence = Number(row.alerts_with_evidence || 0);
  return {
    totalAlertOccurrences: total,
    uniqueAlertNumbers: Number(row.unique_alert_numbers || 0),
    evidenceRecordsCollected: alertsWithEvidence,
    alertsReceivedToday: Number(row.alerts_received_today || 0),
    incidents,
    confirmedNoise,
    unclassified: Math.max(0, total - incidents - confirmedNoise),
    alertsWithEvidence,
    alertsWithoutEvidence: Math.max(0, total - alertsWithEvidence),
  };
}

async function getOperationalOverview(query = {}) {
  await ensureStorage();
  const { params, whereClause } = buildOccurrenceFilters(query);
  const summarySql = (clause = '') => `
    SELECT COUNT(*)::integer AS total,
      COUNT(DISTINCT events.alert_number)::integer AS unique_alert_numbers,
      COUNT(*) FILTER (WHERE
        (events.message_at AT TIME ZONE 'Asia/Kolkata')::date =
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
      )::integer AS alerts_received_today,
      COUNT(*) FILTER (WHERE ${OCCURRENCE_DECISION_SQL}='INCIDENT')::integer AS incidents,
      COUNT(*) FILTER (WHERE latest_outcome.operational_outcome='CONFIRMED_NOISE'
        OR latest_report.evidence_outcome_status='CONFIRMED_NOISE')::integer AS confirmed_noise,
      COUNT(*) FILTER (WHERE ${OCCURRENCE_EVIDENCE_SQL})::integer AS alerts_with_evidence,
      MAX(GREATEST(events.updated_at, latest_outcome.outcome_recorded_at,
        latest_report.submitted_at, latest_refresh.refreshed_at)) AS updated_at
    ${OCCURRENCE_FROM_SQL}
    ${clause}`;
  const globalSummaryPromise = db.query(summarySql());
  const filteredSummaryPromise = whereClause
    ? db.query(summarySql(whereClause), params)
    : globalSummaryPromise;
  const activeSourceSql = `CASE
    WHEN LOWER(events.source_system)='appdynamics' THEN 'AppDynamics'
    WHEN LOWER(events.source_system)='grafana' THEN 'Grafana'
    WHEN LOWER(events.source_system)='nagios' THEN 'Nagios'
    ELSE NULL END`;
  const [globalSummaryResult, filteredSummaryResult, timelineResult, sourceResult, priorityResult, recent] = await Promise.all([
    globalSummaryPromise,
    filteredSummaryPromise,
    db.query(`
      SELECT date_trunc('month', events.message_at) AS period, COUNT(*)::integer AS count
      ${whereClause ? OCCURRENCE_FROM_SQL : 'FROM slack_alert_events events'}
      ${whereClause}
      GROUP BY period ORDER BY period
    `, params),
    db.query(`
      SELECT ${activeSourceSql} AS source, COUNT(*)::integer AS count
      ${whereClause ? OCCURRENCE_FROM_SQL : 'FROM slack_alert_events events'}
      ${whereClause ? `${whereClause} AND ${activeSourceSql} IS NOT NULL` : `WHERE ${activeSourceSql} IS NOT NULL`}
      GROUP BY source ORDER BY count DESC
    `, params),
    db.query(`
      SELECT COALESCE(NULLIF(UPPER(events.priority),''), 'UNKNOWN') AS priority,
        COUNT(*)::integer AS count
      ${whereClause ? OCCURRENCE_FROM_SQL : 'FROM slack_alert_events events'}
      ${whereClause}
      GROUP BY priority ORDER BY priority
    `, params),
    getAlertOccurrences({ ...query, page: 1, pageSize: 6 }),
  ]);
  const globalMetrics = mapSummaryMetrics(globalSummaryResult.rows[0]);
  const filteredMetrics = mapSummaryMetrics(filteredSummaryResult.rows[0]);
  const updatedAt = safeIso(globalSummaryResult.rows[0]?.updated_at) || new Date().toISOString();
  return {
    window: query.range && query.range !== 'all' ? query.range : 'all',
    generatedAt: updatedAt,
    updatedAt,
    totalCount: globalMetrics.totalAlertOccurrences,
    filteredCount: filteredMetrics.totalAlertOccurrences,
    ...globalMetrics,
    filtered: filteredMetrics,
    summary: {
      total: globalMetrics.totalAlertOccurrences,
      uniqueAlertNumbers: globalMetrics.uniqueAlertNumbers,
      evidenceRecordsCollected: globalMetrics.evidenceRecordsCollected,
      alertsReceivedToday: globalMetrics.alertsReceivedToday,
      confirmedIncidents: globalMetrics.incidents,
      confirmedNoise: globalMetrics.confirmedNoise,
      unclassified: globalMetrics.unclassified,
      evidenceAttention: globalMetrics.alertsWithoutEvidence,
      alertsWithEvidence: globalMetrics.alertsWithEvidence,
      alertsWithoutEvidence: globalMetrics.alertsWithoutEvidence,
    },
    outcomes: {
      incident: globalMetrics.incidents,
      noise: globalMetrics.confirmedNoise,
      unclassified: globalMetrics.unclassified,
    },
    timeline: timelineResult.rows.map((item) => ({ period: safeIso(item.period), count: Number(item.count || 0) })),
    sources: sourceResult.rows.map((item) => ({ source: item.source, count: Number(item.count || 0) })),
    priorities: priorityResult.rows.map((item) => ({ priority: item.priority, count: Number(item.count || 0) })),
    recent: recent.items,
    dataSource: {
      name: 'PostgreSQL',
      status: 'LIVE',
      occurrenceTable: 'slack_alert_events',
      cached: false,
    },
    monitoringSources: ['AppDynamics', 'Grafana', 'Nagios'],
    workflowIntegrations: ['Slack', 'Jira'],
    inactiveMonitoringSources: ['ThousandEyes'],
  };
}

function buildFilters(query = {}) {
  const clauses = [];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.search) {
    const param = add(`%${String(query.search).toLowerCase()}%`);
    clauses.push(`(
      LOWER(COALESCE(alert_number, '')) LIKE ${param}
      OR LOWER(COALESCE(title, '')) LIKE ${param}
      OR LOWER(COALESCE(raw_message, '')) LIKE ${param}
      OR LOWER(COALESCE(service, '')) LIKE ${param}
      OR LOWER(COALESCE(responder, '')) LIKE ${param}
    )`);
  }
  if (query.alertNumber) clauses.push(`alert_number = ${add(String(query.alertNumber).replace(/\D/g, ''))}`);
  if (query.source && query.source !== 'all') clauses.push(`LOWER(source_system) = ${add(String(query.source).toLowerCase())}`);
  if (query.severity && query.severity !== 'all') clauses.push(`LOWER(COALESCE(severity, '')) = ${add(String(query.severity).toLowerCase())}`);
  if (query.status && query.status !== 'all') clauses.push(`LOWER(COALESCE(status, '')) = ${add(String(query.status).toLowerCase())}`);
  if (query.environment && query.environment !== 'all') clauses.push(`LOWER(COALESCE(environment, '')) = ${add(String(query.environment).toLowerCase())}`);
  if (query.service && query.service !== 'all') clauses.push(`LOWER(COALESCE(service, '')) = ${add(String(query.service).toLowerCase())}`);
  if (query.team && query.team !== 'all') {
    clauses.push(`LOWER(BTRIM(COALESCE(responder, team, ''))) = ${add(String(query.team).trim().toLowerCase())}`);
  }
  if (query.from) clauses.push(`last_seen >= ${add(query.from)}::date`);
  if (query.to) clauses.push(`last_seen < (${add(query.to)}::date + INTERVAL '1 day')`);

  return {
    params,
    whereClause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
  };
}

function getSortSql(sort) {
  if (sort === 'oldest') return 'first_seen ASC NULLS LAST';
  if (sort === 'severity') return `CASE LOWER(COALESCE(severity, '')) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, last_seen DESC NULLS LAST`;
  if (sort === 'alertNumber') return `alert_number::numeric DESC`;
  if (sort === 'occurrenceCount') return 'occurrence_count DESC, last_seen DESC NULLS LAST';
  return 'last_seen DESC NULLS LAST';
}

async function getNormalizedAlerts(query = {}) {
  await ensureStorage();
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 25, 1), 100);
  const { params, whereClause } = buildFilters(query);
  const countResult = await db.query(`SELECT COUNT(*)::integer AS total FROM slack_normalized_alerts ${whereClause}`, params);
  const total = Number(countResult.rows[0]?.total || 0);
  const listParams = [...params, pageSize, (page - 1) * pageSize];
  const result = await db.query(
    `
      SELECT *
      FROM slack_normalized_alerts
      ${whereClause}
      ORDER BY ${getSortSql(query.sort)}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `,
    listParams,
  );
  const status = await getStatus();

  return {
    items: result.rows.map((row) => mapAlertRow(row)),
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
    extraction: status,
  };
}

async function getAlertById(id) {
  await ensureStorage();
  const occurrence = await getAlertOccurrence(id);
  if (occurrence) return occurrence;
  const result = await db.query(
    'SELECT * FROM slack_normalized_alerts WHERE id = $1',
    [id],
  );
  return mapAlertRow(result.rows[0], { includeRawPayload: true });
}

async function getAlerts(query = {}) {
  return getAlertOccurrences(query);
}

async function getCorrelationsByAlertNumbers(alertNumbers = [], options = {}) {
  const normalizedNumbers = [...new Set(alertNumbers
    .map((value) => String(value || '').replace(/^#/, '').trim())
    .filter((value) => /^\d+$/.test(value)))]
    .slice(0, 100);

  if (normalizedNumbers.length === 0) return {};

  await ensureStorage();
  const result = await db.query(
    `
      SELECT
        events.alert_number,
        events.slack_channel_id,
        events.slack_channel_name,
        events.source_message_ts,
        events.message_at,
        events.author_id,
        events.author_name,
        events.raw_message,
        events.slack_permalink,
        events.thread_ts,
        events.reply_count,
        events.links,
        raw.reactions
      FROM slack_alert_events AS events
      LEFT JOIN slack_raw_messages AS raw
        ON raw.slack_channel_id = events.slack_channel_id
        AND raw.message_ts = events.source_message_ts
      WHERE events.alert_number = ANY($1::text[])
      ORDER BY events.alert_number, events.message_at DESC NULLS LAST, events.source_message_ts DESC
    `,
    [normalizedNumbers],
  );

  const correlations = Object.fromEntries(normalizedNumbers.map((number) => [number, {
    alertNumber: number,
    available: false,
    channelId: null,
    channelName: null,
    latestMessageAt: null,
    messageCount: 0,
    messages: [],
    replyCount: 0,
    slackPermalink: null,
    threadCount: 0,
    threadTs: null,
  }]));

  for (const row of result.rows) {
    const correlation = correlations[row.alert_number];
    if (!correlation) continue;

    correlation.available = true;
    correlation.messageCount += 1;
    correlation.replyCount = Math.max(correlation.replyCount, Number(row.reply_count || 0));
    if (row.thread_ts) correlation.threadCount += 1;

    if (!correlation.latestMessageAt) {
      correlation.channelId = row.slack_channel_id || null;
      correlation.channelName = row.slack_channel_name || null;
      correlation.latestMessageAt = row.message_at
        ? new Date(row.message_at).toISOString()
        : null;
      correlation.slackPermalink = row.slack_permalink || null;
      correlation.threadTs = row.thread_ts || null;
    }

    if (options.includeMessages) {
      correlation.messages.push({
        author: {
          id: row.author_id || null,
          name: row.author_name || null,
        },
        links: Array.isArray(row.links) ? row.links : [],
        message: row.raw_message || null,
        messageAt: row.message_at ? new Date(row.message_at).toISOString() : null,
        messageTs: row.source_message_ts || null,
        reactions: Array.isArray(row.reactions) ? row.reactions : [],
        replyCount: Number(row.reply_count || 0),
        slackPermalink: row.slack_permalink || null,
        threadTs: row.thread_ts || null,
      });
    }
  }

  return correlations;
}

async function getReconciliationReport() {
  await ensureStorage();
  let configuredChannelId = null;
  try {
    configuredChannelId = slackIngestionService.getSlackConfig().channelId;
  } catch (error) {
    // The report remains available for already-stored data when configuration
    // has temporarily been removed.
  }

  const stateResult = await db.query(
    `
      SELECT slack_channel_id, slack_channel_name, workspace_name,
             last_processed_ts, last_successful_fetch_at, poll_status,
             last_error_code, last_error
      FROM slack_alert_live_sync_state
      WHERE ($1::text IS NULL OR slack_channel_id = $1)
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [configuredChannelId],
  );
  const state = stateResult.rows[0] || {};
  const channelId = configuredChannelId || state.slack_channel_id || null;
  if (!channelId) {
    return {
      configured: false,
      evidenceCollectionMode: getEvidenceCollectionMode().value,
      message: 'Slack ingestion is not configured and no stored channel was found.',
    };
  }

  const [coverageResult, cycleResult, eventResult] = await Promise.all([
    db.query(
      `
        SELECT
          COUNT(raw.*)::integer AS slack_messages_found,
          COUNT(events.source_message_ts)::integer AS alerts_stored,
          COUNT(DISTINCT events.alert_number)::integer AS unique_alert_numbers,
          COUNT(*) FILTER (WHERE raw.parsing_status = 'PARSE_FAILED')::integer AS parse_failures,
          (
            SELECT COUNT(*)::integer
            FROM slack_ingestion_errors stored_errors
            WHERE stored_errors.slack_channel_id = $1
          ) AS ingestion_errors_stored,
          COUNT(*) FILTER (WHERE raw.parsing_status = 'NOT_ALERT')::integer AS non_alert_messages,
          COUNT(*) FILTER (WHERE raw.parsing_status = 'UNASSESSED')::integer AS legacy_unassessed_messages,
          COUNT(*) FILTER (
            WHERE events.source_message_ts IS NULL
              AND (
                raw.parsing_status = 'PARSED'
                OR raw.complete_text ~* 'Alert[[:space:]]*(number|no\\.?[[:space:]]*)?#[[:space:]]*[0-9]{3,}'
              )
          )::integer
          + (
            SELECT COUNT(*)::integer
            FROM slack_alert_events missing_raw
            LEFT JOIN slack_raw_messages matching_raw
              ON matching_raw.slack_channel_id = missing_raw.slack_channel_id
             AND matching_raw.message_ts = missing_raw.source_message_ts
            WHERE missing_raw.slack_channel_id = $1
              AND matching_raw.message_ts IS NULL
          ) AS missing_records,
          MIN(raw.message_at) AS first_message_at,
          MAX(raw.message_at) AS last_message_at,
          MAX(raw.ingestion_received_at) AS last_ingestion_received_at
        FROM slack_raw_messages raw
        LEFT JOIN slack_alert_events events
          ON events.slack_channel_id = raw.slack_channel_id
         AND events.source_message_ts = raw.message_ts
        WHERE raw.slack_channel_id = $1
      `,
      [channelId],
    ),
    db.query(
      `
        SELECT
          COALESCE(SUM(duplicates), 0)::integer AS duplicates,
          COALESCE(SUM(permission_failures), 0)::integer AS permission_failures,
          MAX(completed_at) FILTER (WHERE status = 'complete') AS last_complete_cycle_at,
          (ARRAY_AGG(last_successful_cursor ORDER BY completed_at DESC)
            FILTER (WHERE status = 'complete' AND last_successful_cursor IS NOT NULL))[1] AS last_cycle_cursor,
          (ARRAY_AGG(cycle_id ORDER BY started_at DESC))[1] AS latest_cycle_id,
          (ARRAY_AGG(status ORDER BY started_at DESC))[1] AS latest_cycle_status,
          (ARRAY_AGG(messages_found ORDER BY started_at DESC))[1] AS latest_cycle_messages_found,
          (ARRAY_AGG(parse_failures ORDER BY started_at DESC))[1] AS latest_cycle_parse_failures
        FROM slack_ingestion_cycles
        WHERE slack_channel_id = $1
      `,
      [channelId],
    ),
    db.query(
      `
        SELECT events_received, duplicate_events, last_event_received_at,
               last_error_code, last_error
        FROM slack_event_stream_state
        WHERE slack_channel_id = $1
        LIMIT 1
      `,
      [channelId],
    ),
  ]);
  const coverage = coverageResult.rows[0] || {};
  const cycles = cycleResult.rows[0] || {};
  const event = eventResult.rows[0] || {};
  const eventDuplicates = Number(event.duplicate_events || 0);
  const cycleDuplicates = Number(cycles.duplicates || 0);

  return {
    configured: true,
    channelId,
    channelName: state.slack_channel_name || null,
    workspaceName: state.workspace_name || null,
    evidenceCollectionMode: getEvidenceCollectionMode().value,
    permanentArchiveActive: getEvidenceCollectionMode().enabled,
    historicalBackfillActive: syncInProgress,
    slackMessagesFound: Number(coverage.slack_messages_found || 0),
    alertsStored: Number(coverage.alerts_stored || 0),
    uniqueAlertNumbers: Number(coverage.unique_alert_numbers || 0),
    duplicates: cycleDuplicates + eventDuplicates,
    parseFailures: Number(coverage.parse_failures || 0),
    nonAlertMessages: Number(coverage.non_alert_messages || 0),
    legacyUnassessedMessages: Number(coverage.legacy_unassessed_messages || 0),
    permissionFailures: Number(cycles.permission_failures || 0),
    missingRecords: Number(coverage.missing_records || 0),
    ingestionErrorsStored: Number(coverage.ingestion_errors_stored || 0),
    firstMessageAt: coverage.first_message_at || null,
    lastMessageAt: coverage.last_message_at || null,
    lastSuccessfulCursor: state.last_processed_ts || cycles.last_cycle_cursor || null,
    lastSuccessfulIngestionTime: state.last_successful_fetch_at
      || cycles.last_complete_cycle_at
      || coverage.last_ingestion_received_at
      || null,
    latestCycle: {
      id: cycles.latest_cycle_id || null,
      status: cycles.latest_cycle_status || 'not_started',
      messagesFound: Number(cycles.latest_cycle_messages_found || 0),
      parseFailures: Number(cycles.latest_cycle_parse_failures || 0),
    },
    polling: {
      enabled: true,
      status: state.poll_status || 'not_started',
      lastErrorCode: state.last_error_code || null,
      lastError: state.last_error || null,
    },
    eventIngestion: {
      eventsReceived: Number(event.events_received || 0),
      lastEventReceivedAt: event.last_event_received_at || null,
      lastErrorCode: event.last_error_code || null,
      lastError: event.last_error || null,
    },
  };
}

async function getStatus() {
  await ensureStorage();
  const stateResult = await db.query('SELECT * FROM slack_alert_extraction_state ORDER BY updated_at DESC LIMIT 1');
  const liveStateResult = await db.query('SELECT * FROM slack_alert_live_sync_state ORDER BY updated_at DESC LIMIT 1');
  const eventStateResult = await db.query('SELECT * FROM slack_event_stream_state ORDER BY updated_at DESC LIMIT 1');
  const totalsResult = await db.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM slack_raw_messages) AS raw_messages_stored,
      (SELECT COUNT(*)::integer FROM slack_alert_events) AS alert_messages_detected,
      (SELECT COUNT(*)::integer FROM slack_normalized_alerts) AS unique_alert_numbers,
      (SELECT MAX(last_seen) FROM slack_normalized_alerts) AS latest_normalized_alert_at,
      (SELECT MAX(message_at) FROM slack_raw_messages) AS latest_message_at
  `);
  const sourceResult = await db.query(`
    SELECT source_system, COUNT(*)::integer AS count
    FROM slack_alert_events
    GROUP BY source_system
    ORDER BY count DESC, source_system ASC
  `);
  const state = stateResult.rows[0] || {};
  const liveState = liveStateResult.rows[0] || {};
  const eventState = eventStateResult.rows[0] || {};
  const totals = totalsResult.rows[0] || {};
  const liveConfig = getLiveSyncConfig();
  const lastSuccessfulFetchAt = liveState.last_successful_fetch_at
    ? new Date(liveState.last_successful_fetch_at).toISOString()
    : null;
  const freshnessSeconds = lastSuccessfulFetchAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastSuccessfulFetchAt).getTime()) / 1000))
    : null;
  const connected = Boolean(liveState.connected);
  const freshness = !connected || freshnessSeconds === null || freshnessSeconds > liveConfig.staleSeconds
    ? 'Stale'
    : freshnessSeconds >= liveConfig.freshSeconds
      ? 'Delayed'
      : 'Fresh';
  let configured = true;
  try {
    slackIngestionService.getSlackConfig();
  } catch (error) {
    configured = false;
  }
  const eventReceivedAt = eventState.last_event_received_at
    ? new Date(eventState.last_event_received_at).toISOString()
    : null;
  const eventPublicUrlConfigured = /^https:\/\//i.test(process.env.SLACK_EVENTS_PUBLIC_URL || '');
  const permanentEventUrlConfigured = isPermanentSlackEventsUrl(process.env.SLACK_EVENTS_PUBLIC_URL);
  const signingSecretConfigured = Boolean(process.env.SLACK_SIGNING_SECRET);
  const latestPolledAlertAt = totals.latest_normalized_alert_at
    ? new Date(totals.latest_normalized_alert_at).getTime()
    : null;
  const lastDirectAlertAt = eventState.last_alert_received_at
    ? new Date(eventState.last_alert_received_at).getTime()
    : null;
  const eventBehindPolling = Number.isFinite(latestPolledAlertAt)
    && (!Number.isFinite(lastDirectAlertAt) || latestPolledAlertAt > lastDirectAlertAt);
  const eventDeliveryVerified = Boolean(eventReceivedAt) && !eventBehindPolling;
  const directEventsPrimary = permanentEventUrlConfigured && eventDeliveryVerified;
  const eventStreamStatus = eventState.last_error_code
    ? 'degraded'
    : !permanentEventUrlConfigured
      ? eventPublicUrlConfigured ? 'temporary_callback' : 'setup_required'
      : eventBehindPolling
        ? 'stale'
        : eventDeliveryVerified
      ? 'healthy'
      : eventPublicUrlConfigured && signingSecretConfigured
        ? 'awaiting_event'
        : 'setup_required';

  return {
    status: syncInProgress ? 'running' : state.status || 'not_started',
    channelId: state.slack_channel_id || null,
    channelName: state.slack_channel_name || null,
    workspaceName: state.workspace_name || null,
    pagesScanned: Number(state.pages_scanned || 0),
    messagesScanned: Number(state.messages_scanned || 0),
    rawMessagesStored: Number(totals.raw_messages_stored || 0),
    alertMessagesDetected: Number(totals.alert_messages_detected || 0),
    uniqueAlertNumbers: Number(totals.unique_alert_numbers || 0),
    sourceCounts: Object.fromEntries(sourceResult.rows.map((row) => [row.source_system || 'Unknown', Number(row.count || 0)])),
    startedAt: state.started_at || null,
    completedAt: state.completed_at || null,
    lastError: state.last_error || null,
    configured,
    connected,
    backendHealthy: true,
    lastFetchAt: lastSuccessfulFetchAt,
    lastFetchAttemptAt: liveState.last_fetch_at || null,
    lastMessageAt: totals.latest_message_at || liveState.last_message_at || null,
    lastAlertAt: totals.latest_normalized_alert_at || liveState.last_alert_at || null,
    freshness,
    freshnessSeconds,
    freshnessThresholds: {
      freshSeconds: liveConfig.freshSeconds,
      staleSeconds: liveConfig.staleSeconds,
    },
    alertCount: Number(totals.alert_messages_detected || 0),
    liveSync: {
      enabled: true,
      mode: 'fallback_reconciliation',
      role: directEventsPrimary ? 'fallback' : 'active_recovery_path',
      status: incrementalSyncInProgress ? 'polling' : liveState.poll_status || 'not_started',
      pollIntervalSeconds: Number(liveState.poll_interval_seconds || liveConfig.pollIntervalSeconds),
      lastProcessedSlackTimestamp: liveState.last_processed_ts || null,
      messagesProcessed: Number(liveState.messages_processed || 0),
      alertsDetected: Number(liveState.alerts_detected || 0),
      lastBatchMessages: Number(liveState.last_batch_messages || 0),
      lastBatchAlerts: Number(liveState.last_batch_alerts || 0),
      lastErrorCode: liveState.last_error_code || null,
      lastError: liveState.last_error || null,
    },
    eventStream: {
      mode: 'slack_events_api',
      endpoint: '/api/slack/events',
      status: eventStreamStatus,
      primary: directEventsPrimary,
      signingSecretConfigured,
      publicUrlConfigured: eventPublicUrlConfigured,
      permanentPublicUrlConfigured: permanentEventUrlConfigured,
      slackDeliveryVerified: eventDeliveryVerified,
      behindPolling: eventBehindPolling,
      lastEventReceivedAt: eventReceivedAt,
      lastAlertReceivedAt: eventState.last_alert_received_at
        ? new Date(eventState.last_alert_received_at).toISOString()
        : null,
      lastNormalizedAt: eventState.last_normalized_at
        ? new Date(eventState.last_normalized_at).toISOString()
        : null,
      lastFrontendDeliveredAt: eventState.last_frontend_delivered_at
        ? new Date(eventState.last_frontend_delivered_at).toISOString()
        : null,
      eventsReceived: Number(eventState.events_received || 0),
      alertEventsReceived: Number(eventState.alert_events_received || 0),
      duplicateEvents: Number(eventState.duplicate_events || 0),
      detectionLatencyMs: eventState.last_detection_latency_ms ?? null,
      deliveryLatencyMs: eventState.last_delivery_latency_ms ?? null,
      lastErrorCode: eventState.last_error_code || null,
      lastError: eventState.last_error || null,
    },
    evidenceCollectionMode: getEvidenceCollectionMode().value,
    permanentArchiveActive: getEvidenceCollectionMode().enabled,
  };
}

module.exports = {
  ensureStorage,
  encodeOccurrenceId,
  decodeOccurrenceId,
  getAlertById,
  getAlertOccurrence,
  getAlertOccurrences,
  getOperationalOverview,
  getAlerts,
  getNormalizedAlerts,
  getCorrelationsByAlertNumbers,
  getEvidenceCollectionMode,
  getReconciliationReport,
  getStatus,
  ingestSlackEvent,
  recordEventStreamOutcome,
  recordFrontendDelivery,
  refreshFromStoredRaw,
  rebuildNormalizedAlerts,
  syncIncremental,
  storePage,
  syncFullHistory,
  getLiveSyncConfig,
  isPermanentSlackEventsUrl,
  isPotentialAlertMessage,
  cleanOperationalDimension,
  mapSummaryMetrics,
};
