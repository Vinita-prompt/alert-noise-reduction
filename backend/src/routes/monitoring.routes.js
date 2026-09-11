const express = require('express');
const monitoringController = require('../controllers/monitoring.controller');

const router = express.Router();

router.get('/tools', monitoringController.listTools);
router.get('/:tool/dashboards', monitoringController.listApplications);
router.get('/:tool/dashboards/:entityId', monitoringController.getDetails);
router.get('/:tool/entities', monitoringController.listApplications);
router.get('/:tool/entities/:entityId', monitoringController.getDetails);

module.exports = router;
