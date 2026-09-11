const express = require('express');
const { service } = require('../services/atlassian/opsReadValidation.service');
const { service: liveAlertsService } = require('../services/atlassian/operationsLiveAlerts.service');

const router = express.Router();

router.get('/status', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.testConnection() });
  } catch (error) {
    next(error);
  }
});

router.get('/live-alerts/status', async (request, response, next) => {
  try {
    response.json({ success: true, data: await liveAlertsService.getStatus() });
  } catch (error) {
    next(error);
  }
});

router.get('/live-alerts', async (request, response, next) => {
  try {
    response.json({ success: true, data: await liveAlertsService.listLiveAlerts(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/live-alerts/:id/activity', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await liveAlertsService.getActivity(request.params.id, request.query),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/live-alerts/:id/notes', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await liveAlertsService.getNotes(request.params.id, request.query),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/live-alerts/:id/slack-context', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await liveAlertsService.getSlackContext(request.params.id),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/live-alerts/:id', async (request, response, next) => {
  try {
    response.json({ success: true, data: await liveAlertsService.getLiveAlert(request.params.id) });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.listAlerts(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/known/:tinyId', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.findByTinyId(request.params.tinyId) });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/:id/notes', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await service.getNotes(request.params.id, request.query),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/:id/logs', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await service.getLogs(request.params.id, request.query),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/:id', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.getAlert(request.params.id) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
