const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const database = require('../config/db');
const { service: mlShadowService, NOT_TRAINED_STATUS } = require('./mlShadow.service');
const { write: structuredLog } = require('../utils/structuredLogger');

const execFileAsync = promisify(execFile);
const migrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/070_production_ml_learning.sql'),
  'utf8',
);
const DEFAULT_WORKER_INTERVAL_MS = 30_000;
const DEFAULT_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const LEASE_MS = 15 * 60 * 1000;

function enabled(env = process.env) {
  return String(env.ML_AUTOMATED_RETRAINING_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), minimum), maximum) : fallback;
}

function safeError(error) {
  return String(error?.code || error?.message || 'ML_BACKGROUND_JOB_FAILED').replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function parseTrainingOutput(stdout = '') {
  const text = String(stdout).trim();
  if (!text) throw Object.assign(new Error('Training process returned no result.'), { code: 'ML_TRAINING_EMPTY_RESULT' });
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.lastIndexOf('\n{');
    if (start >= 0) return JSON.parse(text.slice(start + 1));
    throw Object.assign(new Error('Training process returned an invalid result.'), { code: 'ML_TRAINING_INVALID_RESULT' });
  }
}

async function runTrainingProcess() {
  const script = path.join(__dirname, '../../scripts/trainMlShadow.js');
  const { stdout } = await execFileAsync(process.execPath, [script], {
    cwd: path.join(__dirname, '../..'),
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  return parseTrainingOutput(stdout);
}

function createMlTrainingOrchestrator({
  db = database,
  ml = mlShadowService,
  clock = () => new Date(),
  trainingRunner = runTrainingProcess,
  workerId = `ml-worker-${process.pid}-${crypto.randomUUID()}`,
  env = process.env,
} = {}) {
  let schemaReady;
  let workerTimer = null;
  let scheduleTimer = null;
  let running = false;

  const workerIntervalMs = boundedInteger(
    env.ML_RETRAIN_WORKER_INTERVAL_MS,
    DEFAULT_WORKER_INTERVAL_MS,
    1_000,
    10 * 60 * 1000,
  );
  const scheduleIntervalMs = boundedInteger(
    env.ML_SCHEDULED_RETRAIN_INTERVAL_MS,
    DEFAULT_SCHEDULE_INTERVAL_MS,
    60_000,
    30 * 24 * 60 * 60 * 1000,
  );
  const maxAttempts = boundedInteger(
    env.ML_TRAINING_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    1,
    10,
  );

  async function ensureSchema() {
    await ml.ensureSchema();
    if (!schemaReady) {
      schemaReady = db.query(migrationSql).catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    await schemaReady;
  }

  async function enqueue({
    jobType,
    triggerType,
    triggerReference,
    alertId = null,
    evaluationId = null,
    evidenceRevision = null,
    idempotencyKey,
  }) {
    await ensureSchema();
    const jobId = `ml-job-${crypto.randomUUID()}`;
    const result = await db.query(`INSERT INTO ml_learning_jobs (
      job_id, idempotency_key, job_type, trigger_type, trigger_reference,
      alert_id, evaluation_id, evidence_revision
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=ml_learning_jobs.updated_at
    RETURNING job_id, job_type, trigger_type, status, requested_at`, [
      jobId, idempotencyKey, jobType, triggerType, triggerReference || null,
      alertId, evaluationId, evidenceRevision,
    ]);
    return { queued: result.rows[0]?.status === 'QUEUED', ...result.rows[0] };
  }

  async function enqueueConfirmedLabel({ reportId, alertId, evaluationId, evidenceRevision }) {
    const retrain = await enqueue({
      jobType: 'RETRAIN', triggerType: 'CONFIRMED_LABEL', triggerReference: reportId,
      alertId, evaluationId, evidenceRevision, idempotencyKey: `retrain:confirmed-label:${reportId}`,
    });
    const prediction = await enqueue({
      jobType: 'PREDICT', triggerType: 'EVIDENCE_REVISION', triggerReference: reportId,
      alertId, evaluationId, evidenceRevision, idempotencyKey: `predict:evidence-revision:${reportId}`,
    });
    return { prediction, retrain };
  }

  async function enqueueScheduled() {
    const bucket = Math.floor(clock().getTime() / scheduleIntervalMs);
    return enqueue({
      jobType: 'RETRAIN', triggerType: 'SCHEDULED', triggerReference: String(bucket),
      idempotencyKey: `retrain:scheduled:${bucket}`,
    });
  }

  async function claim() {
    await ensureSchema();
    const result = await db.query(`UPDATE ml_learning_jobs job SET
      status='RUNNING', attempt_count=attempt_count+1, worker_id=$1,
      started_at=COALESCE(started_at,NOW()), lease_until=NOW()+($2::text || ' milliseconds')::interval,
      updated_at=NOW()
    WHERE job_id=(
      SELECT candidate.job_id FROM ml_learning_jobs candidate
      WHERE (candidate.status IN ('QUEUED','RETRY') AND candidate.available_at<=NOW())
         OR (candidate.status='RUNNING' AND candidate.lease_until<NOW())
      ORDER BY candidate.available_at, candidate.requested_at, candidate.job_id
      FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING job.*`, [workerId, LEASE_MS]);
    return result.rows[0] || null;
  }

  async function complete(job, status, result = {}) {
    await db.query(`UPDATE ml_learning_jobs SET status=$2, result=$3::jsonb,
      model_id=$4, dataset_version=$5, completed_at=NOW(), lease_until=NULL,
      last_error_code=NULL, last_error=NULL, updated_at=NOW()
      WHERE job_id=$1`, [
      job.job_id, status, JSON.stringify(result), result.modelId || null,
      result.datasetVersion || null,
    ]);
  }

  async function fail(job, error) {
    const retry = Number(job.attempt_count || 0) < maxAttempts;
    const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, Number(job.attempt_count || 1) - 1)));
    await db.query(`UPDATE ml_learning_jobs SET status=$2,
      available_at=CASE WHEN $2='RETRY' THEN NOW()+($3::text || ' seconds')::interval ELSE available_at END,
      lease_until=NULL, last_error_code=$4, last_error=$5,
      completed_at=CASE WHEN $2='FAILED' THEN NOW() ELSE completed_at END,
      updated_at=NOW() WHERE job_id=$1`, [
      job.job_id, retry ? 'RETRY' : 'FAILED', delaySeconds,
      String(error?.code || 'ML_BACKGROUND_JOB_FAILED').slice(0, 100), safeError(error),
    ]);
  }

  async function runPrediction(job) {
    const result = await db.query(`SELECT evaluation.*,
      report.form_responses AS structured_evidence,
      COALESCE(report.evidence_revision, $2) AS current_evidence_revision
    FROM live_shadow_evaluations evaluation
    LEFT JOIN LATERAL (
      SELECT value.form_responses, value.evidence_revision
      FROM incident_verification_reports value
      WHERE value.alert_id=evaluation.alert_id
      ORDER BY value.submitted_at DESC, value.report_id DESC LIMIT 1
    ) report ON TRUE
    WHERE evaluation.evaluation_id=$1 LIMIT 1`, [job.evaluation_id, job.evidence_revision]);
    if (!result.rows[0]) return { status: 'EVALUATION_NOT_FOUND', predictionStored: false };
    return ml.predictEvaluation({
      ...result.rows[0],
      evidence_revision: result.rows[0].current_evidence_revision || job.evidence_revision,
    });
  }

  async function processOne() {
    if (running) return { processed: false, reason: 'WORKER_BUSY' };
    running = true;
    let job;
    try {
      job = await claim();
      if (!job) return { processed: false, reason: 'QUEUE_EMPTY' };
      const result = job.job_type === 'RETRAIN' ? await trainingRunner(job) : await runPrediction(job);
      const skipped = result.status === NOT_TRAINED_STATUS
        || ['EVALUATION_NOT_FOUND', 'ALERT_NOT_FOUND'].includes(result.status)
        || result.predictionStored === false;
      await complete(job, skipped ? 'SKIPPED' : 'SUCCEEDED', result);
      return { processed: true, jobId: job.job_id, status: skipped ? 'SKIPPED' : 'SUCCEEDED' };
    } catch (error) {
      if (job) await fail(job, error);
      structuredLog('error', 'ml_background_job_failed', {
        code: error.code || 'ML_BACKGROUND_JOB_FAILED', jobId: job?.job_id || null,
      });
      return { processed: Boolean(job), jobId: job?.job_id || null, status: 'FAILED' };
    } finally {
      running = false;
    }
  }

  async function status() {
    await ensureSchema();
    const result = await db.query(`SELECT status, COUNT(*)::int AS count
      FROM ml_learning_jobs GROUP BY status`);
    const counts = Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
    return {
      enabled: enabled(env), workerStarted: Boolean(workerTimer), workerBusy: running,
      workerIntervalMs, scheduleIntervalMs, maxAttempts,
      queued: counts.QUEUED || 0, running: counts.RUNNING || 0, retry: counts.RETRY || 0,
      succeeded: counts.SUCCEEDED || 0, skipped: counts.SKIPPED || 0, failed: counts.FAILED || 0,
      artifactStorageConfigured: Boolean(String(env.ML_ARTIFACT_STORAGE_DIR || '').trim()),
      mode: 'SHADOW', automaticActionsEnabled: false,
    };
  }

  async function start() {
    await ensureSchema();
    if (!enabled(env) || workerTimer) return status();
    await enqueueScheduled();
    workerTimer = setInterval(() => { processOne().catch(() => {}); }, workerIntervalMs);
    scheduleTimer = setInterval(() => { enqueueScheduled().catch(() => {}); }, scheduleIntervalMs);
    if (typeof workerTimer.unref === 'function') workerTimer.unref();
    if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
    setImmediate(() => { processOne().catch(() => {}); });
    return status();
  }

  function stop() {
    if (workerTimer) clearInterval(workerTimer);
    if (scheduleTimer) clearInterval(scheduleTimer);
    workerTimer = null;
    scheduleTimer = null;
  }

  return {
    claim, enqueue, enqueueConfirmedLabel, enqueueScheduled, ensureSchema,
    processOne, start, status, stop,
  };
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_SCHEDULE_INTERVAL_MS,
  DEFAULT_WORKER_INTERVAL_MS,
  createMlTrainingOrchestrator,
  enabled,
  parseTrainingOutput,
  runTrainingProcess,
  service: createMlTrainingOrchestrator(),
};
