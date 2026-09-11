const express = require('express');
const settingsController = require('../controllers/settings.controller');

const router = express.Router();

router.get('/integrations', settingsController.getIntegrations);
router.put('/integrations/:name', settingsController.updateIntegration);
router.post('/integrations/:name/test', settingsController.testIntegration);
router.post('/integrations/:name/sync', settingsController.syncIntegration);

module.exports = router;
