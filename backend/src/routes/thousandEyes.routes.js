const express = require('express');
const thousandEyesController = require('../controllers/thousandEyes.controller');

const router = express.Router();

router.get('/workspace/dashboard', thousandEyesController.getWorkspaceDashboard);
router.get('/workspace/tests/:id', thousandEyesController.getWorkspaceTest);
router.get('/workspace/agents/:id', thousandEyesController.getWorkspaceAgent);
router.get('/workspace/events', thousandEyesController.listWorkspaceEvents);
router.get('/workspace/events/:id', thousandEyesController.getWorkspaceEvent);
router.get('/workspace/alerts', thousandEyesController.listWorkspaceAlerts);
router.get('/workspace/alerts/:id', thousandEyesController.getWorkspaceAlert);

router.get('/alerts', thousandEyesController.listAlerts);
router.get('/alerts/:id', thousandEyesController.getAlert);
router.get('/tests', thousandEyesController.listTests);
router.get('/tests/:id/results', thousandEyesController.getTestResults);
router.post('/sync', thousandEyesController.sync);

module.exports = router;
