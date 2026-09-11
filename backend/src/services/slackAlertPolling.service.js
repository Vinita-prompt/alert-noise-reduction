const slackAlertStoreService = require('./slackAlertStore.service');
const { service: humanVerificationService } = require('./humanVerification.service');

function createSlackAlertPollingService(dependencies = {}) {
  const store = dependencies.store || slackAlertStoreService;
  const verification = dependencies.verification || (dependencies.store
    ? { queueOccurrence() {}, retryFailedOccurrences: async () => [] }
    : humanVerificationService);
  const setTimer = dependencies.setTimer || setTimeout;
  const clearTimer = dependencies.clearTimer || clearTimeout;
  const logger = dependencies.logger || console;
  let timer = null;
  let stopped = true;
  let runPromise = null;

  function intervalMilliseconds() {
    return store.getLiveSyncConfig().pollIntervalSeconds * 1000;
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimer(() => {
      runOnce().catch(() => {});
    }, intervalMilliseconds());
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function runOnce() {
    if (runPromise) return runPromise;

    const startedAt = new Date().toISOString();
    if (typeof logger.info === 'function') {
      logger.info('Slack alert reconciliation cycle started', {
        code: 'SLACK_RECONCILIATION_CYCLE_STARTED',
        startedAt,
      });
    }
    runPromise = store.syncIncremental()
      .then(async (result) => {
        for (const occurrenceId of result.newOccurrenceIds || []) {
          const occurrence = await store.getAlertOccurrence(occurrenceId);
          if (occurrence) verification.queueOccurrence(occurrence);
        }
        const deliveryRetries = typeof verification.retryFailedOccurrences === 'function'
          ? await verification.retryFailedOccurrences(25)
          : [];
        if (typeof logger.info === 'function') {
          logger.info('Slack alert reconciliation cycle completed', {
            code: 'SLACK_RECONCILIATION_CYCLE_COMPLETED',
            startedAt,
            completedAt: result.completedAt || new Date().toISOString(),
            pagesFetched: Number(result.historyPagesFetched || 0),
            messagesFound: Number(result.recordsRetrieved || 0),
            alertsStored: Number(result.newAlerts || 0),
            rawMessagesStored: Number(result.newMessages || 0),
            duplicates: Number(result.duplicates || 0),
            parseFailures: Number(result.parseFailures || 0),
            skipped: Boolean(result.skipped),
            verificationDeliveryRetries: deliveryRetries.length,
          });
        }
        return { ...result, verificationDeliveryRetries: deliveryRetries.length };
      })
      .catch((error) => {
        logger.error('Incremental Slack alert sync failed', {
          code: error.code || 'SLACK_INCREMENTAL_SYNC_FAILED',
          message: error.safeMessage || error.message,
        });
        throw error;
      })
      .finally(() => {
        runPromise = null;
        scheduleNext();
      });
    return runPromise;
  }

  function startPolling() {
    if (!stopped) return;
    stopped = false;
    runOnce().catch(() => {});
  }

  function stopPolling() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  function getRuntimeState() {
    return {
      intervalSeconds: intervalMilliseconds() / 1000,
      running: Boolean(runPromise),
      started: !stopped,
    };
  }

  return {
    getRuntimeState,
    runOnce,
    startPolling,
    stopPolling,
  };
}

const slackAlertPollingService = createSlackAlertPollingService();

module.exports = {
  createSlackAlertPollingService,
  ...slackAlertPollingService,
};
