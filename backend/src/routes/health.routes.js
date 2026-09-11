const express = require('express');
const db = require('../config/db');
const slackCallbackInboxService = require('../services/slackCallbackInbox.service');
const systemHealthService = require('../services/systemHealth.service');
const { service: mlTrainingOrchestrator } = require('../services/mlTrainingOrchestrator.service');

const router = express.Router();

function live(request, response) {
  response.json({
    status: 'ok',
    service: 'alert-noise-reduction-backend',
    uptimeSeconds: Math.floor(process.uptime()),
  });
}

async function ready(request, response) {
  try {
    await db.query('SELECT 1');
    const [callbacks, mlJobs] = await Promise.all([
      slackCallbackInboxService.getStatus(),
      mlTrainingOrchestrator.status(),
    ]);
    const workerStarted = callbacks.workerStarted === true;
    const permanentCallbacksReady = callbacks.permanentEventUrlConfigured === true
      && callbacks.permanentInteractionUrlConfigured === true;
    const production = process.env.NODE_ENV === 'production';
    const mlRequired = production && mlJobs.enabled;
    const mlReady = !mlRequired || (mlJobs.workerStarted && mlJobs.artifactStorageConfigured);
    const isReady = workerStarted && (!production || permanentCallbacksReady) && mlReady;
    response.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'not_ready',
      database: 'connected',
      slackCallbacks: {
        workerStarted,
        requiredForProduction: true,
        permanentCallbacksReady,
        permanentEventUrlConfigured: callbacks.permanentEventUrlConfigured === true,
        permanentInteractionUrlConfigured: callbacks.permanentInteractionUrlConfigured === true,
        failed: Number(callbacks.failed || 0),
        pending: Number(callbacks.pending || 0),
        processing: Number(callbacks.processing || 0),
        retry: Number(callbacks.retry || 0),
        oldestUnfinishedAt: callbacks.oldest_unfinished_at || null,
        lastCompletedAt: callbacks.last_completed_at || null,
      },
      mlLearning: {
        enabled: mlJobs.enabled,
        requiredForProduction: mlRequired,
        workerStarted: mlJobs.workerStarted,
        artifactStorageConfigured: mlJobs.artifactStorageConfigured,
        queued: mlJobs.queued,
        retry: mlJobs.retry,
        failed: mlJobs.failed,
      },
    });
  } catch (error) {
    response.status(503).json({
      status: 'not_ready',
      database: 'unavailable',
      code: error.code || 'READINESS_CHECK_FAILED',
    });
  }
}

router.get('/live', live);
router.get('/ready', ready);

router.get('/', async (request, response) => {
  try {
    const health = await systemHealthService.getSystemHealth();

    response.json(health);
  } catch (error) {
    response.status(503).json({
      overallStatus: 'Critical',
      lastChecked: new Date().toISOString(),
      services: {
        backend: 'connected',
        database: 'disconnected',
        slack: 'checking',
        jira: 'checking',
        grafana: 'checking',
        appDynamics: 'checking',
        nagios: 'checking',
      },
      connectedServices: 1,
      totalServices: 7,
      status: 'error',
      database: 'disconnected',
      message: error.message,
    });
  }
});

module.exports = router;
module.exports.live = live;
module.exports.ready = ready;
