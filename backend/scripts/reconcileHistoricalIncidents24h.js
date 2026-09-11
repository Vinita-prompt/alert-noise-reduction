require('dotenv').config();

const db = require('../src/config/db');
const { service } = require('../src/services/historicalIncidentReconciliation.service');

async function main() {
  const result = await service.reconcile();
  const byState = result.reconciliations.reduce((counts, item) => ({
    ...counts,
    [item.relationshipState]: (counts[item.relationshipState] || 0) + 1,
  }), {});
  console.log(JSON.stringify({
    alertOccurrencesInspected: result.alertCount,
    incidentTicketsInspected: result.incidentCount,
    jiraMutations: 0,
    reconciliationRunId: result.runId,
    relationships: result.reconciliations.map((item) => ({
      alertId: item.alertId,
      evidence: item.evidence,
      incidentKey: item.incidentKey,
      matchConfidence: item.matchConfidence,
      matchMethod: item.matchMethod,
      matchStrength: item.matchStrength,
      relationshipState: item.relationshipState,
      timeDeltaSeconds: item.timeDeltaSeconds,
    })),
    relationshipTotals: byState,
    windows: result.windows,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.safeMessage || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
