/* eslint-disable no-console */
const { performance } = require('node:perf_hooks');
const db = require('../src/config/db');

const ALERT_COUNT = 50_000;
const INITIAL_EVIDENCE_VERSIONS = 2;
const CONCURRENT_EVENT_COUNT = 100;
const CONCURRENT_EVIDENCE_COUNT = 50;

function elapsed(started) {
  return Number((performance.now() - started).toFixed(2));
}

async function timed(client, sql, values = []) {
  const started = performance.now();
  const result = await client.query(sql, values);
  return { milliseconds: elapsed(started), result };
}

async function main() {
  if (process.env.CAPACITY_LOAD_TEST !== 'isolated') {
    throw new Error('Set CAPACITY_LOAD_TEST=isolated to run the isolated capacity test.');
  }
  const schema = `capacity_test_${process.pid}_${Date.now()}`;
  const name = `"${schema}"`;
  const client = await db.pool.connect();
  const report = {
    mode: 'ISOLATED_SYNTHETIC_CAPACITY_TEST',
    alertCount: ALERT_COUNT,
    evidenceRecordsRequested: ALERT_COUNT * INITIAL_EVIDENCE_VERSIONS,
    learningRecordsRequested: ALERT_COUNT,
    concurrentSlackEvents: CONCURRENT_EVENT_COUNT,
    concurrentEvidenceSubmissions: CONCURRENT_EVIDENCE_COUNT,
  };

  try {
    await client.query(`CREATE SCHEMA ${name}`);
    await client.query(`SET statement_timeout = '120s'`);
    await client.query(`
      CREATE TABLE ${name}.alerts (
        id TEXT PRIMARY KEY,
        alert_number TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        responder TEXT NOT NULL,
        evidence_status TEXT NOT NULL,
        message_at TIMESTAMPTZ NOT NULL,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX capacity_alert_source ON ${name}.alerts(LOWER(source), message_at DESC);
      CREATE INDEX capacity_alert_priority ON ${name}.alerts(LOWER(priority), message_at DESC);
      CREATE INDEX capacity_alert_status ON ${name}.alerts(LOWER(status), message_at DESC);
      CREATE INDEX capacity_alert_responder ON ${name}.alerts(LOWER(BTRIM(responder)), message_at DESC);
      CREATE INDEX capacity_alert_evidence ON ${name}.alerts(evidence_status, message_at DESC);
      CREATE INDEX capacity_alert_timestamp ON ${name}.alerts(message_at DESC, id);
      CREATE INDEX capacity_alert_search ON ${name}.alerts USING GIN (
        to_tsvector('simple', alert_number || ' ' || title || ' ' || source || ' ' || responder)
      );

      CREATE TABLE ${name}.evidence_reports (
        report_id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES ${name}.alerts(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL,
        update_of_report_id TEXT REFERENCES ${name}.evidence_reports(report_id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL UNIQUE,
        human_decision TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        evidence JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(alert_id, version)
      );
      CREATE INDEX capacity_evidence_alert_version ON ${name}.evidence_reports(alert_id, version DESC);

      CREATE TABLE ${name}.evidence_version_events (
        version_event_id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES ${name}.alerts(id) ON DELETE RESTRICT,
        previous_report_id TEXT NOT NULL REFERENCES ${name}.evidence_reports(report_id) ON DELETE RESTRICT,
        new_report_id TEXT NOT NULL UNIQUE REFERENCES ${name}.evidence_reports(report_id) ON DELETE RESTRICT,
        previous_values JSONB NOT NULL,
        new_values JSONB NOT NULL,
        changed_fields TEXT[] NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX capacity_versions_alert_time ON ${name}.evidence_version_events(alert_id, created_at DESC);

      CREATE TABLE ${name}.feedback_learning_records (
        learning_id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL REFERENCES ${name}.alerts(id) ON DELETE RESTRICT,
        report_id TEXT NOT NULL UNIQUE REFERENCES ${name}.evidence_reports(report_id) ON DELETE RESTRICT,
        label TEXT NOT NULL,
        features JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX capacity_learning_label_time ON ${name}.feedback_learning_records(label, created_at DESC);

      CREATE TABLE ${name}.slack_callback_inbox (
        callback_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        occurrence_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        payload JSONB NOT NULL
      );
      CREATE INDEX capacity_callback_work ON ${name}.slack_callback_inbox(status, available_at);
    `);

    const importStarted = performance.now();
    await client.query(`INSERT INTO ${name}.alerts
      SELECT 'capacity-alert-' || value,
        (900000 + value)::text,
        'Capacity alert ' || value || ' application latency',
        (ARRAY['Grafana','AppDynamics','Nagios','ThousandEyes'])[(value % 4) + 1],
        (ARRAY['P1','P2','P3','P4','P5'])[(value % 5) + 1],
        (ARRAY['firing','resolved','acknowledged'])[(value % 3) + 1],
        CASE WHEN value % 2 = 0 THEN 'Command Center' ELSE 'Application Support' END,
        (ARRAY['NOT_STARTED','PARTIAL','COMPLETE','NEEDS_REVIEW'])[(value % 4) + 1],
        NOW() - make_interval(secs => ${ALERT_COUNT} - value),
        jsonb_build_object('synthetic', true, 'sequence', value)
      FROM generate_series(1, ${ALERT_COUNT}) value`);
    await client.query(`INSERT INTO ${name}.evidence_reports
      SELECT 'capacity-report-' || value || '-1', 'capacity-alert-' || value, 1, NULL,
        'capacity-evidence-' || value || '-1',
        CASE WHEN value % 2 = 0 THEN 'NOISE' ELSE 'INCIDENT' END,
        'capacity-reviewer-' || (value % 50),
        jsonb_build_object('status', 'initial', 'alert', value), NOW() - INTERVAL '1 minute'
      FROM generate_series(1, ${ALERT_COUNT}) value`);
    await client.query(`INSERT INTO ${name}.evidence_reports
      SELECT 'capacity-report-' || value || '-2', 'capacity-alert-' || value, 2,
        'capacity-report-' || value || '-1', 'capacity-evidence-' || value || '-2',
        CASE WHEN value % 2 = 0 THEN 'NOISE' ELSE 'INCIDENT' END,
        'capacity-reviewer-' || (value % 50),
        jsonb_build_object('status', 'updated', 'alert', value), NOW()
      FROM generate_series(1, ${ALERT_COUNT}) value`);
    await client.query(`INSERT INTO ${name}.evidence_version_events
      SELECT 'capacity-version-' || value, 'capacity-alert-' || value,
        'capacity-report-' || value || '-1', 'capacity-report-' || value || '-2',
        jsonb_build_object('status', 'initial'), jsonb_build_object('status', 'updated'),
        ARRAY['status']::text[], NOW()
      FROM generate_series(1, ${ALERT_COUNT}) value`);
    await client.query(`INSERT INTO ${name}.feedback_learning_records
      SELECT 'capacity-learning-' || value, 'capacity-alert-' || value,
        'capacity-report-' || value || '-2',
        CASE WHEN value % 2 = 0 THEN 'NOISE' ELSE 'INCIDENT' END,
        jsonb_build_object('source', (ARRAY['Grafana','AppDynamics','Nagios','ThousandEyes'])[(value % 4) + 1], 'priority', (value % 5) + 1),
        NOW()
      FROM generate_series(1, ${ALERT_COUNT}) value`);
    await client.query(`ANALYZE ${name}.alerts; ANALYZE ${name}.evidence_reports`);
    report.importMilliseconds = elapsed(importStarted);

    const firstPage = await timed(client, `SELECT id,alert_number,title,source,priority,status,responder,evidence_status,message_at
      FROM ${name}.alerts ORDER BY message_at DESC,id LIMIT 25 OFFSET 0`);
    const lastPage = await timed(client, `SELECT id,alert_number,title,source,priority,status,responder,evidence_status,message_at
      FROM ${name}.alerts ORDER BY message_at DESC,id LIMIT 25 OFFSET ${ALERT_COUNT - 25}`);
    const search = await timed(client, `SELECT id,alert_number,title FROM ${name}.alerts
      WHERE to_tsvector('simple', alert_number || ' ' || title || ' ' || source || ' ' || responder)
        @@ websearch_to_tsquery('simple', $1)
      ORDER BY message_at DESC LIMIT 25`, ['capacity 49999']);
    const filtered = await timed(client, `SELECT id,alert_number,title FROM ${name}.alerts
      WHERE LOWER(source)='grafana' AND LOWER(priority)='p2'
        AND LOWER(BTRIM(responder))='command center'
      ORDER BY message_at DESC LIMIT 25`);
    report.queries = {
      firstPageMilliseconds: firstPage.milliseconds,
      lastPageMilliseconds: lastPage.milliseconds,
      searchMilliseconds: search.milliseconds,
      searchMatches: search.result.rowCount,
      filteredPageMilliseconds: filtered.milliseconds,
      browserRowsPerPage: firstPage.result.rowCount,
    };

    const evidenceStarted = performance.now();
    await Promise.all(Array.from({ length: CONCURRENT_EVIDENCE_COUNT }, async (_, offset) => {
      const value = offset + 1;
      const connection = await db.pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(`INSERT INTO ${name}.evidence_reports VALUES (
          $1,$2,3,$3,$4,'NEEDS_REVIEW',$5,$6::jsonb,NOW()
        )`, [
          `capacity-report-${value}-3`, `capacity-alert-${value}`,
          `capacity-report-${value}-2`, `capacity-evidence-${value}-3`,
          `capacity-concurrent-reviewer-${value}`, JSON.stringify({ alert: value, concurrent: true }),
        ]);
        await connection.query(`INSERT INTO ${name}.evidence_version_events VALUES (
          $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::text[],NOW()
        )`, [
          `capacity-version-${value}-3`, `capacity-alert-${value}`,
          `capacity-report-${value}-2`, `capacity-report-${value}-3`,
          JSON.stringify({ status: 'updated' }), JSON.stringify({ status: 'concurrent' }), ['status'],
        ]);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    }));
    report.concurrentEvidenceMilliseconds = elapsed(evidenceStarted);

    await client.query(`INSERT INTO ${name}.slack_callback_inbox
      SELECT 'callback-' || value, 'event-id-' || value, 'C-ALERTS:' || value,
        'PENDING',0,NOW(),NULL,jsonb_build_object('alert', value)
      FROM generate_series(1, ${CONCURRENT_EVENT_COUNT}) value`);
    const duplicateAttempt = await client.query(`INSERT INTO ${name}.slack_callback_inbox
      SELECT 'callback-retry-' || value, 'event-id-' || value, 'C-ALERTS:' || value,
        'PENDING',0,NOW(),NULL,jsonb_build_object('alert', value)
      FROM generate_series(1, ${CONCURRENT_EVENT_COUNT}) value
      ON CONFLICT DO NOTHING RETURNING callback_id`);
    await client.query(`UPDATE ${name}.slack_callback_inbox SET status='PROCESSING',attempt_count=1,
      locked_at=NOW()-INTERVAL '5 minutes' WHERE callback_id IN (
        SELECT callback_id FROM ${name}.slack_callback_inbox ORDER BY callback_id LIMIT 10
      )`);
    const recovered = await client.query(`WITH recoverable AS (
      SELECT callback_id FROM ${name}.slack_callback_inbox
      WHERE status='PROCESSING' AND locked_at < NOW()-INTERVAL '2 minutes'
      FOR UPDATE SKIP LOCKED
    ) UPDATE ${name}.slack_callback_inbox inbox SET status='COMPLETED',attempt_count=attempt_count+1,
      locked_at=NULL FROM recoverable WHERE inbox.callback_id=recoverable.callback_id RETURNING inbox.callback_id`);

    const counts = await client.query(`SELECT
      (SELECT COUNT(*)::int FROM ${name}.alerts) alerts,
      (SELECT COUNT(*)::int FROM ${name}.evidence_reports) evidence_reports,
      (SELECT COUNT(*)::int FROM ${name}.evidence_version_events) evidence_version_events,
      (SELECT COUNT(*)::int FROM ${name}.feedback_learning_records) learning_records,
      (SELECT COUNT(*)::int FROM ${name}.slack_callback_inbox) unique_slack_events,
      (SELECT COUNT(*)::int FROM ${name}.evidence_reports WHERE version=3) concurrent_evidence_records,
      (SELECT COUNT(*)::int FROM ${name}.alerts alert WHERE (
        SELECT MAX(version) FROM ${name}.evidence_reports report WHERE report.alert_id=alert.id
      ) >= 2) alerts_with_multiple_evidence_versions`);
    const size = await client.query(`SELECT pg_total_relation_size('${schema}.alerts')
      + pg_total_relation_size('${schema}.evidence_reports')
      + pg_total_relation_size('${schema}.evidence_version_events')
      + pg_total_relation_size('${schema}.feedback_learning_records') AS bytes`);
    report.storage = { ...counts.rows[0], bytes: Number(size.rows[0].bytes) };
    report.duplicateEventsInserted = duplicateAttempt.rowCount;
    report.restartRecoveredCallbacks = recovered.rowCount;
    report.assertions = {
      storageSuccess: Number(counts.rows[0].alerts) === ALERT_COUNT,
      evidenceImportSuccess: Number(counts.rows[0].evidence_reports) === ALERT_COUNT * 2 + CONCURRENT_EVIDENCE_COUNT,
      appendOnlyHistorySuccess: Number(counts.rows[0].evidence_version_events) === ALERT_COUNT + CONCURRENT_EVIDENCE_COUNT,
      multipleEvidencePerAlert: Number(counts.rows[0].alerts_with_multiple_evidence_versions) === ALERT_COUNT,
      learningCapacitySuccess: Number(counts.rows[0].learning_records) === ALERT_COUNT,
      concurrentEvidenceSuccess: Number(counts.rows[0].concurrent_evidence_records) === CONCURRENT_EVIDENCE_COUNT,
      duplicateEventProtection: duplicateAttempt.rowCount === 0 && Number(counts.rows[0].unique_slack_events) === CONCURRENT_EVENT_COUNT,
      restartRecoverySuccess: recovered.rowCount === 10,
      boundedBrowserPage: firstPage.result.rowCount === 25 && lastPage.result.rowCount === 25,
      responsiveSearch: search.milliseconds < 2000,
      responsivePagination: firstPage.milliseconds < 2000 && lastPage.milliseconds < 2000,
    };
    report.passed = Object.values(report.assertions).every(Boolean);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
    client.release();
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error.code || 'CAPACITY_TEST_FAILED', message: error.message }));
  process.exitCode = 1;
});
