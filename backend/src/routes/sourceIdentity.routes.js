const express = require('express');
const { service } = require('../services/sourceIdentity.service');
const { DECISION_LAYER_STATE, retiredDecisionError } = require('../config/decisionLayer');

const router = express.Router();

router.get('/', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.getCoverage(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/resolve', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.resolve(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/completion/status', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: {
        status: 'retired',
        currentPhase: DECISION_LAYER_STATE.currentPhase,
        message: 'Decision-oriented evidence completion is retired. Source identity discovery remains available.',
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/completion', async (request, response, next) => {
  try {
    next(retiredDecisionError());
  } catch (error) {
    next(error);
  }
});

router.get('/:entityId', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.getEntity(request.params.entityId, request.query) });
  } catch (error) {
    next(error);
  }
});

router.post('/:entityId/confirm', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.review(request.params.entityId, 'confirm', request.body) });
  } catch (error) {
    next(error);
  }
});

router.post('/:entityId/reject', async (request, response, next) => {
  try {
    response.json({ success: true, data: await service.review(request.params.entityId, 'reject', request.body) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
