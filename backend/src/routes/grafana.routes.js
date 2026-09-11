const express = require('express');
const grafanaController = require('../controllers/grafana.controller');

const router = express.Router();

router.get('/workspace/status', grafanaController.getWorkspaceStatus);
router.get('/workspace/overview', grafanaController.getWorkspaceOverview);
router.get('/workspace/dashboards', grafanaController.listWorkspaceDashboards);
router.get('/workspace/dashboards/:uid/panels/:panelId/data', grafanaController.getWorkspacePanelData);
router.get('/workspace/dashboards/:uid/panels/:panelId/render', grafanaController.renderWorkspacePanel);
router.get('/workspace/dashboards/:uid', grafanaController.getWorkspaceDashboard);
router.get('/workspace/folders', grafanaController.listWorkspaceFolders);
router.get('/workspace/alert-rules', grafanaController.listWorkspaceAlertRules);
router.get('/workspace/alert-rules/:uid', grafanaController.getWorkspaceAlertRule);
router.get('/workspace/active-alerts', grafanaController.getWorkspaceActiveAlerts);

router.get('/dashboards', grafanaController.listDashboards);
router.post('/dashboards/sync', grafanaController.syncDashboards);
router.get('/folders', grafanaController.listFolders);
router.get('/folders/:folderUid/dashboards', grafanaController.listFolderDashboards);
router.get('/alerts', grafanaController.listAlerts);
router.get('/alert-rules', grafanaController.listAlertRules);
router.post('/alert-rules/sync', grafanaController.syncAlertRules);
router.get('/sync-logs', grafanaController.listSyncLogs);
router.get('/dashboards/:uid/panels', grafanaController.listDashboardPanels);
router.get('/dashboards/:uid/metrics', grafanaController.listDashboardMetrics);
router.get('/dashboards/:uid/panels/:panelId/render', grafanaController.renderPanel);
router.get('/dashboards/:uid', grafanaController.getDashboard);

module.exports = router;
