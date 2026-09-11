const db = require('../src/config/db');
const { syncOpsAlerts } = require('../src/services/atlassian/opsIngestion.service');

const HOURS = 24;

async function main() {
  const to = new Date();
  const from = new Date(to.getTime() - HOURS * 60 * 60 * 1000);
  const result = await syncOpsAlerts({
    foundationOnly: true,
    from: from.toISOString(),
    syncType: 'learning_dataset_24h_refresh',
    to: to.toISOString(),
  });

  process.stdout.write(`${JSON.stringify({
    completedAt: result.completedAt,
    failed: result.failed,
    fetched: result.fetched,
    inserted: result.inserted,
    updated: result.updated,
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.code || 'LEARNING_DATASET_REFRESH_FAILED'}: ${error.safeMessage || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
