#!/usr/bin/env node

const db = require('../src/config/db');
const { service } = require('../src/services/liveMultiSourceEvaluation.service');
const { DECISION_POLICY_VERSION } = require('../src/services/unifiedEvidenceDecision.service');

const EXPECTED_POLICY = 'PHASE13_DECISION_QUALITY_SHADOW_V1';

async function main() {
  if (DECISION_POLICY_VERSION !== EXPECTED_POLICY) {
    throw new Error(`Refusing population run for unexpected policy ${DECISION_POLICY_VERSION}.`);
  }

  let attempted = 0;
  let evaluated = 0;
  let failed = 0;
  const failures = [];

  for (let batch = 1; batch <= 5; batch += 1) {
    const result = await service.evaluatePending({ limit: 100, force: batch === 1 });
    const batchFailures = result.items.filter((item) => item.status === 'FAILED');
    attempted += result.attempted;
    evaluated += result.items.length - batchFailures.length;
    failed += batchFailures.length;
    failures.push(...batchFailures.map((item) => ({ alertId: item.alertId, safeError: item.safeError })));
    process.stdout.write(`${JSON.stringify({
      policy: EXPECTED_POLICY,
      batch,
      attempted: result.attempted,
      evaluated: result.items.length - batchFailures.length,
      failed: batchFailures.length,
      sourceMutations: result.sourceMutations,
    })}\n`);
    if (result.attempted === 0) break;
  }

  const population = await service.listCandidates({ range: '24h', page: 1, pageSize: 1 });
  process.stdout.write(`${JSON.stringify({
    complete: failed === 0,
    policy: EXPECTED_POLICY,
    attempted,
    evaluated,
    failed,
    failures,
    summary: population.summary,
    externalMutations: 0,
  })}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    complete: false,
    safeError: error.code || error.message,
    externalMutations: 0,
  })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
