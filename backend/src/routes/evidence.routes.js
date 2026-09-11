const express = require('express');
const { requireOutcomeOperator } = require('../services/operationalOutcome.service');
const { service: authenticationService } = require('../services/authentication.service');
const { service: humanVerificationService } = require('../services/humanVerification.service');
const { service: evidenceLearningService } = require('../services/evidenceLearning.service');
const { service: evidenceHistoryService } = require('../services/evidenceHistory.service');
const { stripInternalEpisodeIdentifiers } = require('../utils/publicAlertPayload');

const router = express.Router();

router.use((_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  const sendJson = response.json.bind(response);
  response.json = (payload) => sendJson(stripInternalEpisodeIdentifiers(payload));
  next();
});

router.get('/history', requireOutcomeOperator, async (request, response, next) => {
  try {
    response.json({ success: true, data: await evidenceHistoryService.list(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts/:alertId', requireOutcomeOperator, async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await humanVerificationService.incidentReportContext(request.params.alertId),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/alerts/:alertId/refresh', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    const data = await humanVerificationService.slackEvidenceReviewContext(
      request.params.alertId,
      request.body?.evaluationId || null,
      { actionType: 'REFRESH', actorId: request.operationalOutcomeActor?.id || null, origin: request.body?.origin || 'LIVE' },
    );
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/backfill', requireOutcomeOperator, async (request, response, next) => {
  try {
    response.json({ success: true, data: await evidenceLearningService.listBackfill(request.query) });
  } catch (error) {
    next(error);
  }
});

router.post('/backfill/refresh', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await evidenceLearningService.enqueueBackfill({ limit: request.body?.limit }),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/backfill/:alertId/select', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await evidenceLearningService.selectBackfill(
        request.params.alertId,
        request.operationalOutcomeActor,
      ),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/learning/summary', requireOutcomeOperator, async (_request, response, next) => {
  try {
    response.json({ success: true, data: await evidenceLearningService.summary() });
  } catch (error) {
    next(error);
  }
});

router.get('/learning/evaluation', requireOutcomeOperator, async (_request, response, next) => {
  try {
    response.json({ success: true, data: await evidenceLearningService.evaluation() });
  } catch (error) {
    next(error);
  }
});

router.post('/learning/recommendations/:alertId', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await evidenceLearningService.recommendation(request.params.alertId),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/submissions', requireOutcomeOperator, authenticationService.requireCsrf, async (request, response, next) => {
  try {
    const alertId = String(request.body?.alertId || '').trim();
    if (!alertId) {
      response.status(400).json({ success: false, message: 'alertId is required.' });
      return;
    }
    const data = await humanVerificationService.submitEvidence(
      alertId,
      request.body || {},
      request.operationalOutcomeActor,
      {
        channel: 'WEB',
        updateEvidence: request.body?.updateEvidence === true,
        origin: request.body?.origin,
      },
    );
    response.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/attachments/:attachmentId', requireOutcomeOperator, async (request, response, next) => {
  try {
    const attachment = await humanVerificationService.getEvidenceAttachment(request.params.attachmentId);
    if (attachment.externalUrl && !attachment.content) {
      response.redirect(302, attachment.externalUrl);
      return;
    }
    response.set('Content-Type', attachment.mimeType || 'application/octet-stream');
    response.set('Content-Disposition', `attachment; filename="${attachment.fileName.replace(/["\\\r\n]/g, '_')}"`);
    response.send(attachment.content);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
