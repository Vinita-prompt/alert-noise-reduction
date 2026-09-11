require('dotenv').config();

const db = require('../src/config/db');
const { service } = require('../src/services/grafanaEvidenceAcquisition.service');

async function main() {
  const report = await service.reconcile({ refresh: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code || error?.message || 'Grafana evidence reconciliation failed.'}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
