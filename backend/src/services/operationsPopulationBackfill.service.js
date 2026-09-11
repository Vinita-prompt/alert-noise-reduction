const db = require('../config/db');
const operationsIngestionService = require('./atlassian/opsIngestion.service');
const { service: populationReconciliationService } = require('./populationReconciliation.service');

const ROOT_CAUSES = Object.freeze([
  'NOT_INGESTED',
  'INGESTED_BUT_WRONG_WINDOW',
  'INGESTED_BUT_DEDUPLICATION_ERROR',
  'INGESTED_BUT_CANONICAL_ID_MISMATCH',
  'INGESTION_FAILURE',
  'PARSING_FAILURE',
  'SOURCE_NORMALIZATION_FAILURE',
  'OTHER',
]);

function blankRootCauseCounts() {
  return Object.fromEntries(ROOT_CAUSES.map((value) => [value, 0]));
}

function validTime(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : null;
}

function inWindow(value, window = {}) {
  const timestamp = validTime(value);
  const start = validTime(window.start);
  const end = validTime(window.end);
  return timestamp !== null && start !== null && end !== null && timestamp >= start && timestamp <= end;
}

function classifyMissingLocalRow(row = {}, window = {}) {
  if (!row.alert_id && !row.raw_id) return 'NOT_INGESTED';
  if (Number(row.canonical_duplicate_count || 0) > 1) return 'INGESTED_BUT_DEDUPLICATION_ERROR';
  if (row.alert_id) {
    const canonicalMatches = [row.atlassian_ops_alert_id, row.source_alert_id]
      .some((value) => String(value || '') === String(row.expected_id || ''));
    if (!canonicalMatches) return 'INGESTED_BUT_CANONICAL_ID_MISMATCH';
    if (!inWindow(row.received_at, window)) return 'INGESTED_BUT_WRONG_WINDOW';
    return 'OTHER';
  }
  const status = String(row.processing_status || '').toLowerCase();
  const error = String(row.error_message || '').toLowerCase();
  if (status === 'normalization_failed') return 'SOURCE_NORMALIZATION_FAILURE';
  if (/parse|json|malform|syntax/.test(error)) return 'PARSING_FAILURE';
  return 'INGESTION_FAILURE';
}

function createOperationsPopulationBackfillService({
  database = db,
  ingestionService = operationsIngestionService,
  reconciliationService = populationReconciliationService,
} = {}) {
  async function diagnoseMissing(missingIds = [], window = {}) {
    const counts = blankRootCauseCounts();
    if (!missingIds.length) return { counts, records: [] };
    const result = await database.query(`
      WITH missing(expected_id) AS (SELECT unnest($1::text[])),
      alert_candidates AS (
        SELECT candidate.source_alert_id AS match_id, candidate.*
        FROM alerts candidate
        WHERE candidate.source = 'jsm_ops' AND candidate.source_alert_id = ANY($1::text[])
        UNION ALL
        SELECT candidate.atlassian_ops_alert_id AS match_id, candidate.*
        FROM alerts candidate
        WHERE candidate.atlassian_ops_alert_id = ANY($1::text[])
        UNION ALL
        SELECT candidate.raw_payload->>'id' AS match_id, candidate.*
        FROM alerts candidate
        WHERE candidate.raw_payload->>'id' = ANY($1::text[])
        UNION ALL
        SELECT candidate.extracted_details->'normalized_alert'->>'ops_alert_id' AS match_id, candidate.*
        FROM alerts candidate
        WHERE candidate.extracted_details->'normalized_alert'->>'ops_alert_id' = ANY($1::text[])
      ),
      alert_match AS (
        SELECT DISTINCT ON (match_id) match_id, id, received_at,
          atlassian_ops_alert_id, source_alert_id
        FROM alert_candidates
        ORDER BY match_id, created_at DESC
      ),
      raw_candidates AS (
        SELECT candidate.source_alert_id AS match_id, candidate.id,
          candidate.processing_status, candidate.error_message, candidate.received_at
        FROM raw_alerts candidate
        WHERE candidate.source_tool = 'JSM Operations'
          AND candidate.source_alert_id = ANY($1::text[])
        UNION ALL
        SELECT candidate.raw_payload->>'id' AS match_id, candidate.id,
          candidate.processing_status, candidate.error_message, candidate.received_at
        FROM raw_alerts candidate
        WHERE candidate.source_tool = 'JSM Operations'
          AND candidate.raw_payload->>'id' = ANY($1::text[])
      ),
      raw_match AS (
        SELECT DISTINCT ON (match_id) match_id, id, processing_status, error_message
        FROM raw_candidates
        ORDER BY match_id, received_at DESC
      ),
      duplicate AS (
        SELECT match_id, COUNT(DISTINCT id)::integer AS canonical_duplicate_count
        FROM alert_candidates
        GROUP BY match_id
      )
      SELECT missing.expected_id,
        alert.id AS alert_id,
        alert.received_at,
        alert.atlassian_ops_alert_id,
        alert.source_alert_id,
        raw.id AS raw_id,
        raw.processing_status,
        raw.error_message,
        COALESCE(duplicate.canonical_duplicate_count, 0) AS canonical_duplicate_count
      FROM missing
      LEFT JOIN alert_match alert ON alert.match_id = missing.expected_id
      LEFT JOIN raw_match raw ON raw.match_id = missing.expected_id
      LEFT JOIN duplicate ON duplicate.match_id = missing.expected_id
      ORDER BY missing.expected_id
    `, [missingIds]);
    const records = (result.rows || []).map((row) => {
      const rootCause = classifyMissingLocalRow(row, window);
      counts[rootCause] += 1;
      return { alertId: row.expected_id, rootCause };
    });
    return { counts, records };
  }

  async function validateBackfilledPayloads(alertIds = []) {
    if (!alertIds.length) return { alertsChecked: 0, rawPayloadMissing: 0, rawRowsMissing: 0 };
    const result = await database.query(`
      WITH expected(id) AS (SELECT unnest($1::text[]))
      SELECT
        COUNT(*)::integer AS alerts_checked,
        COUNT(*) FILTER (WHERE alert.raw_payload IS NULL OR alert.raw_payload = '{}'::jsonb)::integer AS raw_payload_missing,
        COUNT(*) FILTER (WHERE raw.id IS NULL)::integer AS raw_rows_missing
      FROM expected
      LEFT JOIN alerts alert
        ON alert.source = 'jsm_ops' AND alert.source_alert_id = expected.id
      LEFT JOIN LATERAL (
        SELECT candidate.id
        FROM raw_alerts candidate
        WHERE candidate.source_tool = 'JSM Operations'
          AND candidate.source_alert_id = expected.id
          AND candidate.normalized_alert_id = alert.id
        LIMIT 1
      ) raw ON true
    `, [alertIds]);
    const row = result.rows?.[0] || {};
    return {
      alertsChecked: Number(row.alerts_checked || 0),
      rawPayloadMissing: Number(row.raw_payload_missing || 0),
      rawRowsMissing: Number(row.raw_rows_missing || 0),
    };
  }

  async function run() {
    const before = await reconciliationService.reconcile({ refresh: true, page: 1, pageSize: 1 });
    if (before.provenance?.status !== 'LIVE_RECONCILED') {
      const error = new Error('Authoritative JSM Operations population is unavailable; backfill stopped.');
      error.code = 'AUTHORITATIVE_POPULATION_UNAVAILABLE';
      throw error;
    }
    const missingIds = before.comparison?.missingLocallyIds || [];
    const diagnosis = await diagnoseMissing(missingIds, before.window);
    const sync = missingIds.length ? await ingestionService.syncOpsAlerts({
      foundationOnly: true,
      from: before.window.start,
      sort: 'createdAt',
      syncType: 'population_backfill_24h',
      to: before.window.end,
    }) : { success: true, fetched: 0, inserted: 0, updated: 0, failed: 0 };
    const after = await reconciliationService.reconcile({ refresh: true, page: 1, pageSize: 1 });
    const rawPayload = await validateBackfilledPayloads(missingIds);
    const complete = after.provenance?.status === 'LIVE_RECONCILED'
      && after.comparison?.liveCount === after.comparison?.storedCount
      && after.comparison?.matchedCount === after.comparison?.liveCount
      && after.comparison?.missingLocally === 0
      && after.comparison?.localOnly === 0
      && after.comparison?.duplicateCanonicalIds === 0
      && rawPayload.rawPayloadMissing === 0
      && rawPayload.rawRowsMissing === 0;
    if (!complete) {
      const error = new Error('Operations population did not fully reconcile after canonical backfill.');
      error.code = 'POPULATION_BACKFILL_INCOMPLETE';
      error.safeDetails = {
        liveCount: after.comparison?.liveCount,
        storedCount: after.comparison?.storedCount,
        matchedCount: after.comparison?.matchedCount,
        missingLocally: after.comparison?.missingLocally,
        localOnly: after.comparison?.localOnly,
        duplicates: after.comparison?.duplicateCanonicalIds,
        rawPayload,
      };
      throw error;
    }
    return {
      complete: true,
      before: before.comparison,
      after: after.comparison,
      diagnosis: diagnosis.counts,
      ingestion: sync,
      rawPayload,
      sourceBreakdown: after.sourceBreakdown,
      window: after.window,
      externalMutations: 0,
      reviewsWritten: 0,
      modelTrainingPerformed: false,
      decisionSemanticsChanged: false,
    };
  }

  return { diagnoseMissing, run, validateBackfilledPayloads };
}

module.exports = {
  ROOT_CAUSES,
  blankRootCauseCounts,
  classifyMissingLocalRow,
  createOperationsPopulationBackfillService,
  service: createOperationsPopulationBackfillService(),
};
