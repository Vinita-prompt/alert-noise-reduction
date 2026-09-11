require('dotenv').config();

const db = require('../src/config/db');
const slackAlertStoreService = require('../src/services/slackAlertStore.service');

async function main() {
  const result = await slackAlertStoreService.refreshFromStoredRaw({
    alertsOnly: true,
    batchSize: 1000,
    onProgress(progress) {
      if (progress.processed === progress.total || progress.processed % 25000 === 0) {
        console.log(JSON.stringify({ ...progress, status: 'refreshing' }));
      }
    },
  });
  console.log(JSON.stringify({ status: 'complete', ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      code: error.code || 'SLACK_ALERT_REFRESH_FAILED',
      message: error.safeMessage || error.message,
      status: 'failed',
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
