const express = require('express');
const nagiosController = require('../controllers/nagios.controller');

const router = express.Router();

router.get('/health', nagiosController.getHealth);
router.get('/:instance(d01|d02)/workspace/records/:entityType(host|service)/:recordId', nagiosController.getWorkspaceRecord);
router.get('/:instance(d01|d02)/workspace/records/:entityType(host|service)', nagiosController.listWorkspaceRecords);
router.get('/:instance(d01|d02)/workspace', nagiosController.getWorkspace);
router.get('/:instance(d01|d02)', nagiosController.getSnapshot);
router.post('/:instance(d01|d02)/poll', nagiosController.pollInstance);
router.get('/:instance(d01|d02)/service-summary', nagiosController.getServiceSummary);
router.get('/:instance(d01|d02)/host-summary', nagiosController.getHostSummary);
router.get('/:instance(d01|d02)/services', nagiosController.getServices);
router.get('/:instance(d01|d02)/hosts', nagiosController.getHosts);
router.get('/:instance(d01|d02)/problems', nagiosController.getProblems);
router.get('/:instance(d01|d02)/events', nagiosController.getEvents);
router.get('/:instance(d01|d02)/downtime', nagiosController.getDowntime);
router.get('/:instance(d01|d02)/ai-features', nagiosController.getAiFeatures);
router.get('/:instance(d01|d02)/sync-logs', nagiosController.getSyncLogs);

module.exports = router;
