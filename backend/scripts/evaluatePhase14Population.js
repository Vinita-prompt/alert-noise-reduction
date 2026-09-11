#!/usr/bin/env node

const db = require('../src/config/db');
const { service } = require('../src/services/liveMultiSourceEvaluation.service');
const { DECISION_POLICY_VERSION } = require('../src/services/unifiedEvidenceDecision.service');

const EXPECTED_POLICY = 'EPISODE_BASED_SHADOW_V2';

async function main() {
  if (DECISION_POLICY_VERSION !== EXPECTED_POLICY) {
    throw new Error(`Refusing population run for unexpected policy ${DECISION_POLICY_VERSION}.`);
  }

  const force = process.argv.includes('--force');
  const quiet = process.argv.includes('--quiet');
  if (quiet) {
    console.log = () => {};
    console.info = () => {};
    console.debug = () => {};
  }
  const staleBeforeArg = process.argv.find((value) => value.startsWith('--stale-before='));
  const staleBeforeValue = staleBeforeArg?.slice('--stale-before='.length) || null;
  const staleBefore = staleBeforeValue && !Number.isNaN(new Date(staleBeforeValue).getTime())
    ? new Date(staleBeforeValue).toISOString() : null;
  const sourceArg = process.argv.find((value) => value.startsWith('--source='));
  const sourceFilter = sourceArg?.slice('--source='.length) || null;
  const runId = `${Date.now()}-${process.pid}`;
  const workersArg = process.argv.find((value) => value.startsWith('--workers='));
  const requestedWorkers = Number.parseInt(workersArg?.split('=')[1] || '4', 10);
  const workerCount = Math.max(1, Math.min(4, Number.isFinite(requestedWorkers) ? requestedWorkers : 4));
  const populationResult = await db.query(`
    SELECT alert.id
    FROM alerts alert
    LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
    WHERE alert.atlassian_ops_alert_id IS NOT NULL
      AND alert.received_at >= NOW() - INTERVAL '24 hours'
      AND (
        $2::boolean
        OR evaluation.decision_policy IS DISTINCT FROM $1
        OR ($3::timestamptz IS NOT NULL AND (evaluation.created_at IS NULL OR evaluation.created_at < $3::timestamptz))
      )
      AND ($4::text IS NULL OR (CASE
        WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'appd%' THEN 'AppDynamics'
        WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'grafana%' THEN 'Grafana'
        WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'nagios%' THEN 'Nagios'
        WHEN REPLACE(LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)), ' ', '') LIKE 'thousandeyes%' THEN 'ThousandEyes'
        ELSE 'Unsupported/Unknown' END) = $4::text)
    ORDER BY alert.received_at DESC, alert.id DESC
  `, [EXPECTED_POLICY, force, staleBefore, sourceFilter]);
  const populationIds = populationResult.rows.map((row) => row.id);
  let attempted = 0;
  let evaluated = 0;
  let failed = 0;
  const failures = [];
  for (let offset = 0; offset < populationIds.length; offset += 100) {
    const ids = populationIds.slice(offset, offset + 100);
    const items = new Array(ids.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(workerCount, ids.length) }, async () => {
      while (nextIndex < ids.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          const result = await service.evaluate(ids[index], {
            requestId: `phase14-bounded-${runId}-${ids[index]}`,
          });
          items[index] = { alertId: ids[index], evaluationId: result.evaluationId, status: 'EVALUATED' };
        } catch (error) {
          items[index] = { alertId: ids[index], status: 'FAILED', safeError: error.code || error.message };
        }
      }
    }));
    const batchFailures = items.filter((item) => item.status === 'FAILED');
    attempted += ids.length;
    evaluated += items.length - batchFailures.length;
    failed += batchFailures.length;
    failures.push(...batchFailures.map((item) => ({ alertId: item.alertId, safeError: item.safeError })));
    process.stdout.write(`${JSON.stringify({
      policy: EXPECTED_POLICY,
      batch: Math.floor(offset / 100) + 1,
      attempted: ids.length,
      evaluated: items.length - batchFailures.length,
      failed: batchFailures.length,
      workers: workerCount,
      sourceMutations: 0,
    })}\n`);
  }
  const population = await service.listCandidates({ range: '24h', page: 1, pageSize: 1 });
  const failureSummary = Object.entries(failures.reduce((result, item) => {
    result[item.safeError] = Number(result[item.safeError] || 0) + 1;
    return result;
  }, {})).map(([safeError, count]) => ({ safeError, count }));
  process.stdout.write(`${JSON.stringify({
    complete: failed === 0,
    policy: EXPECTED_POLICY,
    attempted,
    evaluated,
    failed,
    failureSummary,
    failureSamples: failures.slice(0, 10),
    summary: population.summary,
    externalMutations: 0,
    automaticActions: 'DISABLED',
  })}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ complete: false, safeError: error.code || error.message, externalMutations: 0 })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
