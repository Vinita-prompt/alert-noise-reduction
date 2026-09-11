#!/usr/bin/env node

const db = require('../src/config/db');
const { service } = require('../src/services/liveMultiSourceEvaluation.service');

async function main() {
  await service.ensureSchema();
  const diagnostics = await service.episodeDiagnostics({ refresh: true });
  process.stdout.write(`${JSON.stringify({
    policy: 'EPISODE_BASED_SHADOW_V1',
    ...diagnostics,
  }, null, process.argv.includes('--compact') ? 0 : 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    policy: 'EPISODE_BASED_SHADOW_V1',
    safeError: error.code || error.message,
    externalMutations: 0,
  })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
