const crypto = require('node:crypto');
const { service: alertEpisodeService } = require('./alertEpisode.service');

const MAX_CONCURRENCY = 4;

function clean(value) {
  return String(value ?? '').trim();
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function configuredEnabled() {
  return String(process.env.OCCURRENCE_AWARE_EPISODE_GROUPING_ENABLED || 'false').toLowerCase() === 'true';
}

function createLiveOccurrenceAutomationService({
  enabled = configuredEnabled,
  episodeLayer = alertEpisodeService,
  evaluationService = null,
  schedule = (callback) => setImmediate(callback),
  now = () => Date.now(),
} = {}) {
  const pending = new Map();
  let scheduled = false;
  let running = false;
  let latestRun = null;

  function evaluator() {
    return evaluationService || require('./liveMultiSourceEvaluation.service').service;
  }

  async function drain() {
    if (running || !enabled()) return { attempted: 0, items: [], sourceMutations: 0 };
    running = true;
    scheduled = false;
    const batch = [...pending.values()];
    pending.clear();
    episodeLayer.invalidate?.();
    const items = new Array(batch.length);
    let next = 0;
    const workers = Math.min(MAX_CONCURRENCY, batch.length);
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < batch.length) {
        const index = next;
        next += 1;
        const item = batch[index];
        try {
          const evaluation = await evaluator().evaluate(item.alertId, {
            refresh: true,
            requestId: `live-occurrence-${hash(`${item.alertId}|${item.reason}|${now()}`)}`,
          });
          items[index] = {
            alertId: item.alertId,
            episodeId: evaluation.context?.episode?.episodeId || evaluation.featureSnapshot?.episode?.episodeId || null,
            groupingBasis: evaluation.context?.episode?.episodeGroupingBasis
              || evaluation.featureSnapshot?.episode?.episodeGroupingBasis || null,
            notificationRole: evaluation.notificationRole,
            finalDecision: evaluation.finalDecision,
            decisionRevision: evaluation.evaluationId,
            evidenceRevision: evaluation.featureAsOf,
            trigger: item.reason,
            status: 'EVALUATED',
          };
        } catch (error) {
          items[index] = {
            alertId: item.alertId,
            trigger: item.reason,
            status: 'FAILED',
            safeError: clean(error?.safeMessage || error?.code || error?.message || 'Evaluation failed.'),
          };
        }
      }
    }));
    latestRun = {
      completedAt: new Date(now()).toISOString(),
      attempted: batch.length,
      items,
      automaticGrouping: true,
      localShadowClassification: true,
      externalMutations: 0,
    };
    running = false;
    if (pending.size) scheduleDrain();
    return latestRun;
  }

  function scheduleDrain() {
    if (scheduled || running || !enabled()) return;
    scheduled = true;
    schedule(() => {
      drain().catch(() => {
        running = false;
        scheduled = false;
      });
    });
  }

  function enqueue(alertIds, reason = 'NEW_ALERT_INGESTED') {
    const values = Array.isArray(alertIds) ? alertIds : [alertIds];
    const accepted = [];
    if (!enabled()) return { accepted, enabled: false, queued: pending.size };
    values.map(clean).filter(Boolean).forEach((alertId) => {
      pending.set(alertId, { alertId, reason: clean(reason) || 'NEW_ALERT_INGESTED' });
      accepted.push(alertId);
    });
    scheduleDrain();
    return { accepted, enabled: true, queued: pending.size };
  }

  function status() {
    return {
      enabled: enabled(),
      queued: pending.size,
      running,
      latestRun,
      externalMutations: 0,
    };
  }

  return { drain, enqueue, status };
}

module.exports = {
  MAX_CONCURRENCY,
  createLiveOccurrenceAutomationService,
  service: createLiveOccurrenceAutomationService(),
};
