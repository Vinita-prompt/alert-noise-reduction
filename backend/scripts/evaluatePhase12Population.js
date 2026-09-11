#!/usr/bin/env node

const db = require('../src/config/db');
const { service } = require('../src/services/liveMultiSourceEvaluation.service');

async function main() {
  let attempted = 0;
  let evaluated = 0;
  let failed = 0;
  const failures = [];

  for (let batch = 1; batch <= 5; batch += 1) {
    const result = await service.evaluatePending({ limit: 100 });
    attempted += result.attempted;
    evaluated += result.items.filter((item) => item.status === 'EVALUATED').length;
    const batchFailures = result.items.filter((item) => item.status === 'FAILED');
    failed += batchFailures.length;
    failures.push(...batchFailures.map((item) => ({ alertId: item.alertId, safeError: item.safeError })));
    process.stdout.write(`${JSON.stringify({ batch, attempted: result.attempted, evaluated: result.items.length - batchFailures.length, failed: batchFailures.length, sourceMutations: result.sourceMutations })}\n`);
    if (result.attempted === 0) break;
  }

  process.stdout.write(`${JSON.stringify({ complete: failed === 0, attempted, evaluated, failed, failures, externalMutations: 0 })}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ complete: false, safeError: error.code || error.message, externalMutations: 0 })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
