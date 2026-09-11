const express = require('express');
const { service: mlService } = require('../services/mlShadow.service');
const { service: mlTrainingOrchestrator } = require('../services/mlTrainingOrchestrator.service');

const router = express.Router();

router.use((_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

router.get('/status', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await mlService.status() });
  } catch (error) { next(error); }
});

router.get('/models', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await mlService.models() });
  } catch (error) { next(error); }
});

router.get('/models/:id', async (request, response, next) => {
  try {
    const model = await mlService.model(request.params.id);
    if (!model) {
      response.status(404).json({ success: false, message: 'Model not found.' });
      return;
    }
    response.json({ success: true, data: model });
  } catch (error) { next(error); }
});

router.get('/predictions/:alertId', async (request, response, next) => {
  try {
    response.json({ success: true, data: await mlService.prediction(request.params.alertId) });
  } catch (error) { next(error); }
});

router.get('/metrics', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await mlService.metrics() });
  } catch (error) { next(error); }
});

router.get('/training-dataset', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await mlService.trainingDatasetSummary() });
  } catch (error) { next(error); }
});

router.get('/jobs/status', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await mlTrainingOrchestrator.status() });
  } catch (error) { next(error); }
});

module.exports = router;
