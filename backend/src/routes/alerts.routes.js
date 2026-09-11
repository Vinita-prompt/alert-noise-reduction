const express = require('express');
const alertsController = require('../controllers/alerts.controller');
const liveAlertStreamService = require('../services/liveAlertStream.service');
const slackAlertStoreService = require('../services/slackAlertStore.service');
const { service: authenticationService } = require('../services/authentication.service');

const router = express.Router();

router.get('/status', async (request, response, next) => {
  try {
    const data = await slackAlertStoreService.getStatus();
    response.json({
      success: true,
      data: {
        ...data,
        eventStream: {
          ...data.eventStream,
          ...liveAlertStreamService.getRuntimeState(),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/stream', (request, response) => {
  liveAlertStreamService.subscribe(request, response);
});

router.get('/live', authenticationService.requireAuthenticated, async (request, response, next) => {
  try {
    const data = await slackAlertStoreService.getAlerts({
      ...request.query,
      // This endpoint is the product's rolling operational view. Historical
      // occurrences remain in the archive and cannot leak into this response.
      range: '24h',
    });
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/overview', authenticationService.requireAuthenticated, async (request, response, next) => {
  try {
    response.json({ success: true, data: await slackAlertStoreService.getOperationalOverview(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/summary', authenticationService.requireAuthenticated, async (request, response, next) => {
  try {
    response.json({ success: true, data: await slackAlertStoreService.getOperationalOverview(request.query) });
  } catch (error) {
    next(error);
  }
});

router.post('/live/:id/delivered', async (request, response, next) => {
  try {
    const deliveredAt = request.body?.frontendDeliveredAt || new Date().toISOString();
    const parsed = new Date(deliveredAt);
    if (Number.isNaN(parsed.getTime()) || Math.abs(Date.now() - parsed.getTime()) > 60 * 60 * 1000) {
      response.status(400).json({
        error: 'Invalid frontend delivery timestamp.',
        message: 'frontendDeliveredAt must be a valid timestamp within one hour of the server clock.',
      });
      return;
    }
    const data = await slackAlertStoreService.recordFrontendDelivery(
      request.params.id,
      parsed.toISOString(),
    );
    if (!data) {
      response.status(404).json({ error: 'Slack-derived alert not found.' });
      return;
    }
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/', (request, response, next) => {
  if (request.query.feed !== 'canonical') {
    slackAlertStoreService.getAlerts(request.query)
      .then((data) => response.json({ success: true, ...data }))
      .catch(next);
    return;
  }
  alertsController.getAlerts(request, response, next);
});
router.post('/ingest', alertsController.ingestAlert);
router.post('/classify', alertsController.classifyAlerts);
router.get('/trend', alertsController.getAlertTrend);
router.get('/sources/summary', alertsController.getSourceDashboardSummary);
router.post('/:id/acknowledge', alertsController.acknowledgeAlert);
router.post('/:id/assign', alertsController.assignAlert);
router.post('/:id/snooze', alertsController.snoozeAlert);
router.post('/:id/close', alertsController.closeAlert);
router.post('/:id/jira-ticket', alertsController.createJiraTicket);
router.post('/:id/escalate', alertsController.escalateAlert);
router.post('/:id/notes', alertsController.addAlertNote);
router.post('/:id/responders', alertsController.addAlertResponder);
router.post('/:id/link-jira', alertsController.linkJiraIncident);
router.post('/:id/process', alertsController.processAlert);
router.get('/:id/linked-incidents', alertsController.getAlertLinkedIncidents);
router.get('/:id/raw', alertsController.getAlertRawPayload);
router.get('/:id/activity', alertsController.getAlertActivity);
router.get('/:id', alertsController.getAlertById);
router.post('/:id/actions', alertsController.applyAlertAction);

module.exports = router;
