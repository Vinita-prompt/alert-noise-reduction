const express = require('express');
const abcHubController = require('../controllers/abcHub.controller');

const router = express.Router();

router.post('/import/daemon-monitor', abcHubController.importDaemonMonitor);
router.get('/daemon-monitor', abcHubController.getDaemonMonitor);
router.get('/daemon-monitor/summary', abcHubController.getDaemonMonitor);
router.get('/daemon-monitor/details', abcHubController.getDaemonMonitor);
router.get('/daemon-monitor/history', abcHubController.getDaemonHistory);

router.get('/datatrak-user-monitoring', abcHubController.getDataTrakUserMonitoring);
router.get('/datatrak-user-monitoring/history', abcHubController.getDataTrakUserHistory);
router.get('/datatrak-user-monitoring/:id', abcHubController.getDataTrakUserDetails);

module.exports = router;
