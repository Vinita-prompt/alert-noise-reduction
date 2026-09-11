const express = require('express');
const { service: evaluationService } = require('../services/liveMultiSourceEvaluation.service');
const { service: populationReconciliationService } = require('../services/populationReconciliation.service');
const { service: episodeCorrelationDiscoveryService } = require('../services/episodeCorrelationDiscovery.service');
const { service: identityRelationshipEnrichmentService } = require('../services/identityRelationshipEnrichment.service');
const { requireOutcomeOperator } = require('../services/operationalOutcome.service');
const { service: authenticationService } = require('../services/authentication.service');
const { service: humanVerificationService } = require('../services/humanVerification.service');
const { stripInternalEpisodeIdentifiers } = require('../utils/publicAlertPayload');

const router = express.Router();

router.use((_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  const sendJson = response.json.bind(response);
  response.json = (payload) => sendJson(stripInternalEpisodeIdentifiers(payload));
  next();
});

router.get('/', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.listCandidates(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/connectivity', async (request, response, next) => {
  try {
    const refresh = String(request.query.refresh || '').toLowerCase() === 'true';
    const data = refresh
      ? await evaluationService.validateConnectivity({ source: request.query.source })
      : { checks: await evaluationService.latestConnectivity(), externalMutations: 0 };
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/gold-dataset', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.goldDataset(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/gold-review', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.goldReviewQueue(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/gold-review-queue', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.goldReviewQueue(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/training-dataset-preview', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.trainingDatasetPreview(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/reconciliation', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.reconciliation(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/population-reconciliation', async (request, response, next) => {
  try {
    response.json({ success: true, data: await populationReconciliationService.reconcile(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/episodes', async (request, response, next) => {
  try {
    response.json({ success: true, data: await evaluationService.episodeDiagnostics(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/correlation-discovery', async (request, response, next) => {
  try {
    response.json({ success: true, data: await episodeCorrelationDiscoveryService.discover(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/identity-relationship-enrichment', async (request, response, next) => {
  try {
    response.json({ success: true, data: await identityRelationshipEnrichmentService.analyze(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/feedback-summary', async (_request, response, next) => {
  try {
    response.json({ success: true, data: await humanVerificationService.summary() });
  } catch (error) { next(error); }
});

router.get('/human-verification/tests/:testRunId', async (request, response, next) => {
  try {
    const data = await humanVerificationService.getControlledTest(request.params.testRunId);
    if (!data) {
      response.status(404).json({ success: false, message: 'Controlled verification test not found.' });
      return;
    }
    response.json({ success: true, data });
  } catch (error) { next(error); }
});

router.get('/human-verification/validation/slack', requireOutcomeOperator, async (_request, response, next) => {
  try {
    response.json({ success: true, data: await humanVerificationService.validateControlledTestAccess() });
  } catch (error) { next(error); }
});

router.post('/human-verification/test', requireOutcomeOperator, authenticationService.requireCsrf, async (_request, response, next) => {
  try {
    response.status(201).json({ success: true, data: await humanVerificationService.sendControlledTest() });
  } catch (error) { next(error); }
});

router.post('/human-verification/deliveries/:deliveryId/retry', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    response.json({ success: true, data: await humanVerificationService.retryDelivery(request.params.deliveryId) });
  } catch (error) { next(error); }
});

router.get('/:alertId/incident-report', async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await humanVerificationService.incidentReportContext(request.params.alertId),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:alertId/incident-report', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    const data = await humanVerificationService.submitIncidentReport(
      request.params.alertId,
      request.body || {},
      request.operationalOutcomeActor,
    );
    response.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.post('/:alertId/run', async (request, response, next) => {
  try {
    const data = await evaluationService.evaluate(request.params.alertId, {
      refresh: request.body?.refresh === true,
      requestId: request.get('X-Request-Id'),
    });
    response.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/:alertId', async (request, response, next) => {
  try {
    const data = await evaluationService.latest(request.params.alertId);
    if (!data) {
      response.status(404).json({ success: false, message: 'No shadow evaluation exists for this alert.' });
      return;
    }
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/:alertId/evidence', async (request, response, next) => {
  try {
    const data = await evaluationService.latest(request.params.alertId);
    if (!data) {
      response.status(404).json({ success: false, message: 'No shadow evaluation exists for this alert.' });
      return;
    }
    response.json({
      success: true,
      data: {
        evaluationId: data.evaluationId,
        technicalEvidence: data.technicalEvidence,
        evidenceVector: data.evidenceVector,
        evidenceReferences: data.evidenceReferences,
        adapterDiagnostics: data.adapterDiagnostics,
        sourceDetails: data.sourceDetails,
        sourceProvenance: data.sourceProvenance,
        context: data.context,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:alertId/decision', async (request, response, next) => {
  try {
    const data = await evaluationService.latest(request.params.alertId);
    if (!data) {
      response.status(404).json({ success: false, message: 'No shadow evaluation exists for this alert.' });
      return;
    }
    response.json({
      success: true,
      data: {
        evaluationId: data.evaluationId,
        prioritySignal: data.prioritySignal,
        noiseDetection: data.noiseDetection,
        classification: data.classification,
        businessImpact: data.businessImpact,
        actionability: data.actionability,
        underlyingEvent: data.underlyingEvent,
        notificationRole: data.notificationRole,
        finalDecision: data.finalDecision,
        evidenceScore: data.evidenceScore,
        decisionConfidence: data.decisionConfidence,
        decisionPolicy: data.decisionPolicy,
        evaluationStatus: data.evaluationStatus,
        feedbackStatus: data.feedbackStatus,
        model: data.model,
        explanation: data.explanation,
        failureReasons: data.failureReasons,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:alertId/feedback', async (request, response, next) => {
  try {
    const data = await evaluationService.latest(request.params.alertId);
    if (!data) {
      response.status(404).json({ success: false, message: 'No shadow evaluation exists for this alert.' });
      return;
    }
    response.json({ success: true, data: data.feedback });
  } catch (error) {
    next(error);
  }
});

router.post('/:alertId/feedback', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    const data = await evaluationService.recordFeedback(
      request.params.alertId,
      request.body?.evaluationId,
      request.body,
      request.operationalOutcomeActor,
      {
        idempotencyKey: request.get('Idempotency-Key'),
        requestContext: {
          method: request.method,
          path: request.path,
          requestId: request.get('X-Request-Id') || null,
          evaluationId: request.body?.evaluationId || null,
        },
      },
    );
    response.status(data.operationalOutcome?.corrected ? 200 : 201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
