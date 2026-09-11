const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const database = require('../config/db');

const migrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/064_slack_callback_inbox.sql'),
  'utf8',
);

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_SECONDS = 120;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutSlackSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSlackSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) => {
    const normalized = key.toLowerCase();
    if (['token', 'response_url', 'authorization'].includes(normalized)) return [];
    return [[key, withoutSlackSecrets(nested)]];
  }));
}

function callbackIdentity(kind, payload = {}) {
  if (kind === 'EVENT') {
    if (payload.event_id) return `event:${payload.event_id}`;
    return `event-message:${payload.event?.channel || 'unknown'}:${payload.event?.ts || 'unknown'}`;
  }
  const action = payload.actions?.[0] || {};
  const parts = [
    payload.type,
    payload.team?.id || payload.enterprise?.id,
    payload.user?.id,
    action.action_id,
    action.action_ts,
    payload.trigger_id,
    payload.container?.channel_id || payload.channel?.id,
    payload.container?.message_ts || payload.message?.ts,
    payload.view?.id,
    payload.view?.hash,
    payload.view?.callback_id,
  ].filter(Boolean);
  return parts.length >= 3
    ? `interaction:${parts.join(':')}`
    : `interaction-payload:${canonicalJson(withoutSlackSecrets(payload))}`;
}

function callbackIdempotencyKey(kind, payload) {
  return crypto.createHash('sha256').update(callbackIdentity(kind, payload)).digest('hex');
}

function safeError(error) {
  return {
    code: String(error?.code || 'SLACK_CALLBACK_PROCESSING_FAILED').slice(0, 160),
    message: String(error?.safeMessage || error?.message || 'Slack callback processing failed.').slice(0, 1000),
  };
}

function isPermanentHttpsCallback(value, expectedPath) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:'
      && parsed.pathname === expectedPath
      && !['localhost', '127.0.0.1'].includes(parsed.hostname)
      && !/trycloudflare\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function createPostgresRepository({ db = database, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  let schemaPromise = null;
  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = db.query(migrationSql).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    await schemaPromise;
  }

  async function insert(record) {
    await ensureSchema();
    const result = await db.query(`INSERT INTO slack_callback_inbox (
      callback_id,idempotency_key,callback_kind,callback_type,action_id,payload,received_at
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *`, [
      record.callbackId, record.idempotencyKey, record.kind, record.type,
      record.actionId, JSON.stringify(record.payload), record.receivedAt,
    ]);
    if (result.rows[0]) return { duplicate: false, row: result.rows[0] };
    const existing = await db.query(
      'SELECT * FROM slack_callback_inbox WHERE idempotency_key=$1 LIMIT 1',
      [record.idempotencyKey],
    );
    return { duplicate: true, row: existing.rows[0] };
  }

  async function claimOne(callbackId) {
    await ensureSchema();
    const result = await db.query(`WITH candidate AS (
      SELECT callback_id FROM slack_callback_inbox
      WHERE callback_id=$1
        AND available_at <= NOW()
        AND (status IN ('PENDING','RETRY')
          OR (status='PROCESSING' AND locked_at < NOW() - ($2::int * INTERVAL '1 second')))
      FOR UPDATE SKIP LOCKED
    )
    UPDATE slack_callback_inbox inbox
    SET status='PROCESSING',attempt_count=inbox.attempt_count+1,locked_at=NOW(),updated_at=NOW()
    FROM candidate WHERE inbox.callback_id=candidate.callback_id
    RETURNING inbox.*`, [callbackId, leaseSeconds]);
    return result.rows[0] || null;
  }

  async function claimBatch(limit) {
    await ensureSchema();
    const result = await db.query(`WITH candidates AS (
      SELECT callback_id FROM slack_callback_inbox
      WHERE available_at <= NOW()
        AND (status IN ('PENDING','RETRY')
          OR (status='PROCESSING' AND locked_at < NOW() - ($2::int * INTERVAL '1 second')))
      ORDER BY received_at ASC
      LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE slack_callback_inbox inbox
    SET status='PROCESSING',attempt_count=inbox.attempt_count+1,locked_at=NOW(),updated_at=NOW()
    FROM candidates WHERE inbox.callback_id=candidates.callback_id
    RETURNING inbox.*`, [limit, leaseSeconds]);
    return result.rows;
  }

  async function complete(callbackId) {
    await db.query(`UPDATE slack_callback_inbox SET
      status='COMPLETED',completed_at=NOW(),locked_at=NULL,
      last_error_code=NULL,last_error=NULL,updated_at=NOW()
      WHERE callback_id=$1`, [callbackId]);
  }

  async function fail(row, error, maxAttempts) {
    const failure = safeError(error);
    const terminal = Number(row.attempt_count || 0) >= maxAttempts;
    const delaySeconds = Math.min(300, 2 ** Math.max(0, Number(row.attempt_count || 1) - 1));
    await db.query(`UPDATE slack_callback_inbox SET
      status=$2,available_at=NOW()+($3::int*INTERVAL '1 second'),locked_at=NULL,
      last_error_code=$4,last_error=$5,updated_at=NOW()
      WHERE callback_id=$1`, [
      row.callback_id, terminal ? 'FAILED' : 'RETRY', delaySeconds,
      failure.code, failure.message,
    ]);
    return { terminal, ...failure };
  }

  async function status() {
    await ensureSchema();
    const [result, failures] = await Promise.all([db.query(`SELECT
      COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
      COUNT(*) FILTER (WHERE status='PROCESSING')::int AS processing,
      COUNT(*) FILTER (WHERE status='RETRY')::int AS retry,
      COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed,
      MIN(received_at) FILTER (WHERE status IN ('PENDING','PROCESSING','RETRY')) AS oldest_unfinished_at,
      MAX(completed_at) AS last_completed_at
      FROM slack_callback_inbox`), db.query(`SELECT
        callback_id, callback_kind, callback_type, action_id, status,
        attempt_count, received_at, updated_at, last_error_code, last_error
      FROM slack_callback_inbox
      WHERE status='FAILED'
      ORDER BY updated_at DESC
      LIMIT 25`)]);
    return {
      ...(result.rows[0] || {}),
      recentFailures: failures.rows.map((row) => ({
        actionId: row.action_id,
        attemptCount: Number(row.attempt_count || 0),
        callbackId: row.callback_id,
        callbackKind: row.callback_kind,
        callbackType: row.callback_type,
        errorCode: row.last_error_code,
        errorMessage: row.last_error,
        receivedAt: row.received_at,
        status: row.status,
        updatedAt: row.updated_at,
      })),
    };
  }

  return { claimBatch, claimOne, complete, ensureSchema, fail, insert, status };
}

async function defaultProcessor(row) {
  const payload = row.payload || {};
  if (row.callback_kind === 'INTERACTION') {
    const { service } = require('./humanVerification.service');
    return service.handleSlackInteraction(payload, { callbackId: row.callback_id });
  }

  const slackAlertStoreService = require('./slackAlertStore.service');
  const liveAlertStreamService = require('./liveAlertStream.service');
  const { service: humanVerificationService } = require('./humanVerification.service');
  const event = payload.event || {};
  let result;
  try {
    result = await slackAlertStoreService.ingestSlackEvent(event, {
      eventReceivedAt: row.received_at,
      slackEventId: payload.event_id || null,
    });
    await slackAlertStoreService.recordEventStreamOutcome(event.channel, result);
  } catch (error) {
    await slackAlertStoreService.recordEventStreamOutcome(event.channel, {
      error,
      eventReceivedAt: row.received_at,
      slackEventId: payload.event_id || null,
    }).catch(() => {});
    throw error;
  }
  if (result.isAlert && !result.duplicate && result.alert) {
    humanVerificationService.queueOccurrence(result.alert);
    liveAlertStreamService.broadcast('alert', {
      alert: result.alert,
      newNormalizedAlert: result.newNormalizedAlert,
      timing: {
        detectionLatencyMs: result.detectionLatencyMs,
        eventReceivedTime: result.eventReceivedAt,
        frontendDeliveredAt: null,
        normalizedAt: result.normalizedAt,
        slackMessageTime: result.slackMessageTime,
      },
    });
  }
  return result;
}

function createSlackCallbackInboxService({
  repository = createPostgresRepository(),
  processor = defaultProcessor,
  logger = console,
  clock = () => new Date(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  setImmediateFn = setImmediate,
  batchSize = DEFAULT_BATCH_SIZE,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  let timer = null;
  let batchPromise = null;

  async function processClaimed(row) {
    try {
      await processor(row);
      await repository.complete(row.callback_id);
      return { callbackId: row.callback_id, status: 'COMPLETED' };
    } catch (error) {
      const failure = await repository.fail(row, error, maxAttempts);
      logger.error({
        code: failure.code,
        callbackId: row.callback_id,
        callbackKind: row.callback_kind,
        status: failure.terminal ? 'FAILED' : 'RETRY',
      });
      return { callbackId: row.callback_id, status: failure.terminal ? 'FAILED' : 'RETRY' };
    }
  }

  async function processOne(callbackId) {
    const row = await repository.claimOne(callbackId);
    return row ? processClaimed(row) : { callbackId, status: 'NOT_CLAIMED' };
  }

  async function processBatch() {
    if (batchPromise) return batchPromise;
    batchPromise = (async () => {
      const rows = await repository.claimBatch(batchSize);
      return Promise.all(rows.map(processClaimed));
    })().finally(() => { batchPromise = null; });
    return batchPromise;
  }

  function processSoon(callbackId) {
    setImmediateFn(() => processOne(callbackId).catch((error) => logger.error({
      code: error.code || 'SLACK_CALLBACK_DISPATCH_FAILED', callbackId,
    })));
  }

  async function enqueue(kind, payload, receivedAt = clock().toISOString()) {
    const sanitized = withoutSlackSecrets(payload);
    const idempotencyKey = callbackIdempotencyKey(kind, sanitized);
    const inserted = await repository.insert({
      callbackId: `slcb-${crypto.randomUUID()}`,
      idempotencyKey,
      kind,
      type: String(sanitized.type || 'unknown'),
      actionId: sanitized.actions?.[0]?.action_id || null,
      payload: sanitized,
      receivedAt,
    });
    const callbackId = inserted.row?.callback_id || inserted.row?.callbackId;
    if (!inserted.duplicate && callbackId) processSoon(callbackId);
    return { callbackId, duplicate: inserted.duplicate, status: inserted.row?.status || 'PENDING' };
  }

  async function start() {
    if (timer) return;
    await repository.ensureSchema();
    await processBatch();
    timer = setTimer(() => processBatch().catch((error) => logger.error({
      code: error.code || 'SLACK_CALLBACK_WORKER_FAILED',
    })), pollIntervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return {
    enqueue,
    ensureSchema: () => repository.ensureSchema(),
    getStatus: async () => ({
      ...(await repository.status()),
      workerStarted: Boolean(timer),
      batchRunning: Boolean(batchPromise),
      permanentEventUrlConfigured: isPermanentHttpsCallback(
        process.env.SLACK_EVENTS_PUBLIC_URL,
        '/api/slack/events',
      ),
      permanentInteractionUrlConfigured: isPermanentHttpsCallback(
        process.env.SLACK_INTERACTIONS_PUBLIC_URL,
        '/api/slack/interactions',
      ),
    }),
    processBatch,
    processOne,
    start,
    stop,
  };
}

const slackCallbackInboxService = createSlackCallbackInboxService({
  batchSize: Math.min(Math.max(Number(process.env.SLACK_CALLBACK_BATCH_SIZE || DEFAULT_BATCH_SIZE), 1), 100),
  maxAttempts: Math.min(Math.max(Number(process.env.SLACK_CALLBACK_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS), 1), 20),
  pollIntervalMs: Math.min(
    Math.max(Number(process.env.SLACK_CALLBACK_WORKER_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS), 1_000),
    60_000,
  ),
});

module.exports = {
  callbackIdempotencyKey,
  createPostgresRepository,
  createSlackCallbackInboxService,
  withoutSlackSecrets,
  isPermanentHttpsCallback,
  ...slackCallbackInboxService,
};
