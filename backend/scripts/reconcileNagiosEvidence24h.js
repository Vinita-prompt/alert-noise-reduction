require('dotenv').config();

const db = require('../src/config/db');
const { service } = require('../src/services/nagiosEvidenceAcquisition.service');

async function main() {
  const report = await service.reconcile({ refresh: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.safeMessage || error?.code || error?.message || 'Nagios evidence reconciliation failed.'}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
