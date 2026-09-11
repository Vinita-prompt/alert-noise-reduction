const express = require('express');
const integrationsController = require('../controllers/integrations.controller');

const router = express.Router();

router.get('/', integrationsController.getIntegrations);
router.get('/atlassian/status', integrationsController.getAtlassianStatus);
router.post('/atlassian/test', integrationsController.testAtlassianConnection);
router.post('/atlassian/ops/sync', integrationsController.syncAtlassianOps);
router.get('/atlassian/ops/sync-runs', integrationsController.getAtlassianOpsSyncRuns);
router.get('/atlassian/jsm/service-desks', integrationsController.getAtlassianJsmServiceDesks);
router.get('/atlassian/jsm/requests', integrationsController.getAtlassianJsmRequests);
router.get('/jira/status', integrationsController.getJiraStatus);
router.get('/operations/backfill/status', integrationsController.getOperationsBackfillStatus);
router.post('/slack/history/import', integrationsController.importSlackChannelHistory);
router.post('/slack/history/backfill', integrationsController.startSlackHistoryBackfill);
router.get('/slack/history/status', integrationsController.getSlackHistoryImportStatus);
router.post('/slack/history/sync', integrationsController.syncNewSlackNotifications);
router.post('/jira/alerts/import', integrationsController.importJiraAlertIssues);
router.post('/jira/incidents/import', integrationsController.importJiraIncidents);
router.post('/operations/alerts/import', integrationsController.importJiraAlertIssues);
router.post('/:tool', integrationsController.createIntegration);
router.put('/:tool', integrationsController.updateIntegration);
router.delete('/:tool', integrationsController.deleteIntegration);
router.post('/:tool/test', integrationsController.testIntegration);

module.exports = router;
