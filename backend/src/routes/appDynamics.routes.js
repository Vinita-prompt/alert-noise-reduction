const express = require('express');
const appDynamicsService = require('../services/appDynamics.service');
const appDynamicsEvidenceAcquisitionService = require('../services/appDynamicsEvidenceAcquisition.service').service;

const router = express.Router();

router.get('/status', async (request, response, next) => {
  try {
    response.json({ data: await appDynamicsService.getSafeConfigPreview() });
  } catch (error) {
    next(error);
  }
});

router.post('/connect', async (request, response, next) => {
  try {
    response.json({ data: await appDynamicsService.testConnection() });
  } catch (error) {
    next(error);
  }
});

router.post('/disconnect', async (request, response, next) => {
  try {
    response.json({ data: await appDynamicsService.disconnect() });
  } catch (error) {
    next(error);
  }
});

router.post('/test', async (request, response, next) => {
  try {
    response.json({ data: await appDynamicsService.testConnection() });
  } catch (error) {
    next(error);
  }
});

router.post('/sync', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.syncAppDynamicsData({
        applicationLimit: request.body?.applicationLimit,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/evidence/reconcile', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsEvidenceAcquisitionService.reconcile({
        from: request.body?.from,
        to: request.body?.to,
        refresh: request.body?.refresh === true,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications', async (request, response, next) => {
  try {
    response.json({ data: await appDynamicsService.listApplications() });
  } catch (error) {
    next(error);
  }
});

router.get('/workspace/applications', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getWorkspaceApplications({
        direction: request.query.direction,
        page: request.query.page,
        range: request.query.range,
        refresh: request.query.refresh === 'true',
        search: request.query.search,
        sort: request.query.sort,
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/workspace/applications/:applicationId', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getWorkspaceApplication(request.params.applicationId, {
        eventPage: request.query.eventPage,
        eventPageSize: request.query.eventPageSize,
        range: request.query.range,
        refresh: request.query.refresh === 'true',
        refreshStatic: request.query.refreshStatic === 'true',
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/dashboard', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationDashboard(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/flowmap', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationFlowMap(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/business-transactions', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationBusinessTransactions(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/nodes', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationNodes(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/servers', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationServers(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/events', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationEvents(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/policies', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationPoliciesReadOnly(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/snapshots', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationSnapshots(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/metrics', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationMetrics(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationId/transaction-score', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationTransactionScore(request.params.applicationId),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/applications/:applicationName', async (request, response, next) => {
  try {
    response.json({
      data: await appDynamicsService.getApplicationDetails(request.params.applicationName),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/data', async (request, response, next) => {
  try {
    const applications = await appDynamicsService.listApplications();
    response.json({
      data: {
        applications,
        connectionState: await appDynamicsService.getConnectionState(),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
