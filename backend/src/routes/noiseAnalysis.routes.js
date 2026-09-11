const express = require('express');
const { DECISION_LAYER_STATE, retiredDecisionError } = require('../config/decisionLayer');
const { service: learningDatasetService } = require('../services/historicalLearningDataset.service');
const {
  requireOutcomeOperator,
  service: operationalOutcomeService,
} = require('../services/operationalOutcome.service');
const { service: authenticationService } = require('../services/authentication.service');
const {
  requireTaxonomyOperator,
  service: alertTaxonomyService,
} = require('../services/alertTaxonomy.service');
const incidentRiskExperimentService = require('../services/incidentRiskExperiment.service');
const { service: appDynamicsJiraOutcomeService } = require('../services/appDynamicsJiraOutcomeReconstruction.service');

const router = express.Router();

async function foundationStatus(request, response, next) {
  try {
    response.json({
      success: true,
      data: await learningDatasetService.getStatus(request.query),
      meta: {
        backwardCompatibility: 'The route remains available and now reports the occurrence-level historical learning dataset.',
        legacyDecisionFieldsAuthoritative: false,
        mlModelTrained: false,
        productionMlModelTrained: false,
        offlineShadowExperimentEndpoint: '/api/noise-analysis/foundation/shadow-experiment',
      },
    });
  } catch (error) {
    next(error);
  }
}

router.get('/', foundationStatus);
router.get('/status', foundationStatus);

router.get('/foundation', async (request, response, next) => {
  try {
    const data = await learningDatasetService.list(request.query);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/summary', async (request, response, next) => {
  try {
    const data = await learningDatasetService.summary(request.query);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/audit', async (request, response, next) => {
  try {
    const data = await learningDatasetService.summary({ ...request.query, range: request.query.range || 'all' });
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/sample', async (request, response, next) => {
  try {
    const data = await learningDatasetService.representativeSample(request.query.limit || 10);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/training-preview', async (request, response, next) => {
  try {
    const data = await learningDatasetService.trainingPreview(request.query);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/features/audit', async (request, response, next) => {
  try {
    const data = await learningDatasetService.featureAudit(request.query);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/shadow-experiment', async (request, response, next) => {
  try {
    const experiment = await incidentRiskExperimentService.getLatestExperiment();
    response.json({
      success: true,
      data: experiment ? {
        experimentId: experiment.experiment_id,
        modelVersion: experiment.model_version,
        experimentState: experiment.experiment_state,
        modelFamily: experiment.model_family,
        featureSchemaVersion: experiment.feature_schema_version,
        taxonomyVersion: experiment.taxonomy_version,
        createdAt: experiment.created_at,
        report: experiment.metadata,
        productionDecisionEnabled: false,
        automaticActionsEnabled: false,
      } : {
        experimentState: 'NO_SHADOW_EXPERIMENT',
        productionDecisionEnabled: false,
        automaticActionsEnabled: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/appdynamics-jira-outcomes', async (request, response, next) => {
  try {
    response.json({ success: true, data: await appDynamicsJiraOutcomeService.list(request.query) });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/appdynamics-jira-outcomes/summary', async (request, response, next) => {
  try {
    response.json({ success: true, data: await appDynamicsJiraOutcomeService.summary() });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/appdynamics-jira-outcomes/:alertId', async (request, response, next) => {
  try {
    const data = await appDynamicsJiraOutcomeService.get(request.params.alertId);
    if (!data) {
      response.status(404).json({ success: false, message: 'AppDynamics reconstruction record not found.' });
      return;
    }
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.get('/foundation/:alertId/taxonomy', async (request, response, next) => {
  try {
    const data = await alertTaxonomyService.get(request.params.alertId);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

async function correctTaxonomy(request, response, next) {
  try {
    const data = await alertTaxonomyService.record(
      request.params.alertId,
      request.body,
      request.taxonomyActor,
      {
        idempotencyKey: request.get('Idempotency-Key'),
        requestContext: {
          method: request.method,
          path: request.path,
          requestId: request.get('X-Request-Id') || null,
        },
      },
    );
    response.status(data.corrected || data.duplicateSubmission ? 200 : 201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

router.post('/foundation/:alertId/taxonomy', requireTaxonomyOperator, authenticationService.requireCsrf, correctTaxonomy);
router.patch('/foundation/:alertId/taxonomy', requireTaxonomyOperator, authenticationService.requireCsrf, correctTaxonomy);

router.get('/foundation/:alertId/outcome', async (request, response, next) => {
  try {
    const data = await operationalOutcomeService.get(request.params.alertId);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

async function recordOperationalOutcome(request, response, next) {
  try {
    const data = await operationalOutcomeService.record(
      request.params.alertId,
      request.body,
      request.operationalOutcomeActor,
      {
        idempotencyKey: request.get('Idempotency-Key'),
        requestContext: {
          method: request.method,
          path: request.path,
          requestId: request.get('X-Request-Id') || null,
        },
      },
    );
    response.status(data.corrected || data.duplicateSubmission ? 200 : 201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

router.post('/foundation/:alertId/outcome', requireOutcomeOperator, authenticationService.requireCsrf, recordOperationalOutcome);
router.patch('/foundation/:alertId/outcome', requireOutcomeOperator, authenticationService.requireCsrf, recordOperationalOutcome);

router.get('/foundation/:alertId', async (request, response, next) => {
  try {
    const data = await learningDatasetService.get(request.params.alertId, request.query);
    response.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

router.all('*', (request, response, next) => {
  const error = retiredDecisionError();
  error.safeDetails = {
    currentPhase: DECISION_LAYER_STATE.currentPhase,
    requestedPath: request.path,
    replacementClassifierEnabled: false,
  };
  next(error);
});

module.exports = router;
