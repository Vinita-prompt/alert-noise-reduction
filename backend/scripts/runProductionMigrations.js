const { service: humanVerificationService } = require('../src/services/humanVerification.service');
const { service: authAccountService } = require('../src/services/authAccount.service');
const slackAlertStoreService = require('../src/services/slackAlertStore.service');
const { service: mlTrainingOrchestrator } = require('../src/services/mlTrainingOrchestrator.service');

async function run() {
  await authAccountService.ensureSchema();
  await humanVerificationService.ensureSchema();
  await slackAlertStoreService.ensureStorage();
  await mlTrainingOrchestrator.ensureSchema();
  process.stdout.write('Database migrations: PASS\n');
}

run().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`Database migrations: FAIL (${error.code || 'MIGRATION_FAILED'})\n`);
  process.exit(1);
});
