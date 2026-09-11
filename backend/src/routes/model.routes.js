const express = require('express');
const { service: evaluationService } = require('../services/liveMultiSourceEvaluation.service');

const router = express.Router();

router.use((_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

router.get('/performance', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.performance() });
  } catch (error) {
    next(error);
  }
});

router.get('/status', async (_request, response, next) => {
  try {
    const performance = await evaluationService.performance();
    response.json({
      success: true,
      data: {
        modelVersion: performance.modelVersion,
        releaseStatus: performance.releaseStatus,
        mode: performance.mode,
        evaluationDataStatus: performance.evaluationDataStatus,
        goldDataset: performance.goldDataset,
        releaseGates: performance.releaseGates,
        automaticActionsEnabled: false,
        productionDecisionsEnabled: false,
        predictionsCreateLabels: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
