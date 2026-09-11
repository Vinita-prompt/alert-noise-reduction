require('dotenv').config();

const { service } = require('../src/services/liveMultiSourceEvaluation.service');
const nagiosService = require('../src/services/nagios.service');

const CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.PHASE9_RECONCILIATION_CONCURRENCY || 2)));
const LIMIT = Math.min(100, Math.max(1, Number(process.env.PHASE9_RECONCILIATION_LIMIT || 100)));
const SOURCE = String(process.env.PHASE9_RECONCILIATION_SOURCE || '').trim();
const INCOMPLETE_ONLY = String(process.env.PHASE9_RECONCILIATION_INCOMPLETE_ONLY || '').toLowerCase() === 'true';

async function run() {
  if (SOURCE.toLowerCase() === 'nagios') {
    nagiosService.clearNagiosWorkspaceCache();
    // Current inventory is useful context, but Phase 9C historical occurrence
    // reconstruction must not be blocked when an entity is no longer current.
    await Promise.allSettled([
      nagiosService.getWorkspaceSnapshot('d01', { forceRefresh: true }),
      nagiosService.getWorkspaceSnapshot('d02', { forceRefresh: true }),
    ]);
  }
  const request = { page: 1, pageSize: 100, ...(SOURCE ? { source: SOURCE } : {}) };
  const initial = await service.reconciliation(request);
  const eligible = INCOMPLETE_ONLY ? initial.items.filter((item) => !item.evaluable) : initial.items;
  const targets = eligible.slice(0, LIMIT);
  let cursor = 0;
  let passed = 0;
  let failed = 0;

  async function worker() {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      try {
        const evaluation = await service.evaluate(target.alertId, {
          refresh: false,
          requestId: `phase9-reconcile-${Date.now()}-${index}`,
        });
        const coverage = evaluation.technicalEvidence?.coverage;
        if (coverage?.evaluability?.evaluable) passed += 1;
        else failed += 1;
        process.stdout.write(`${target.alert} ${target.source}: ${coverage?.sourceResolution?.status || 'UNRESOLVED'} / ${coverage?.evidenceCompleteness?.status || 'MISSING'}\n`);
      } catch (error) {
        failed += 1;
        process.stdout.write(`${target.alert} ${target.source}: REQUEST_FAILED (${String(error?.code || error?.status || 'SAFE_ERROR')})\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const final = await service.reconciliation(request);
  process.stdout.write(`${JSON.stringify({
    attempted: targets.length,
    source: SOURCE || 'ALL_SUPPORTED_SOURCES',
    evaluableAfterRefresh: passed,
    stillBlocked: failed,
    completionGate: final.completionGate,
    summary: {
      totalAlerts: final.summary.totalAlerts,
      sourceResolved: final.summary.sourceResolved,
      technicalEvidenceComplete: final.summary.technicalEvidenceComplete,
      evaluableAlerts: final.summary.evaluableAlerts,
      sourceUnresolved: final.summary.sourceUnresolved,
      sourceApiUnavailable: final.summary.sourceApiUnavailable,
      evidenceMissing: final.summary.evidenceMissing,
    },
    sourceMutations: 0,
  })}\n`);
}

run().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`Phase 9 reconciliation failed safely: ${String(error?.code || error?.status || 'SAFE_ERROR')}\n`);
  process.exit(1);
});
