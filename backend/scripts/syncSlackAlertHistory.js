require('dotenv').config();

const db = require('../src/config/db');
const slackAlertStoreService = require('../src/services/slackAlertStore.service');

async function main() {
  const result = await slackAlertStoreService.syncFullHistory({
    maxPages: 'all',
    pageSize: 100,
    onProgress(progress) {
      if (progress.pagesScanned === 1 || progress.pagesScanned % 10 === 0) {
        console.log(JSON.stringify({
          alertMessagesDetected: progress.alertMessagesDetected,
          messagesScanned: progress.messagesScanned,
          pagesScanned: progress.pagesScanned,
          status: 'running',
        }));
      }
    },
  });

  console.log(JSON.stringify({ status: 'complete', ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      code: error.code || 'SLACK_ALERT_SYNC_FAILED',
      message: error.safeMessage || error.message,
      status: 'failed',
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
