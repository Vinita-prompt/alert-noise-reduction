const express = require('express');
const ingestionController = require('../controllers/ingestion.controller');

const router = express.Router();

router.get('/sources', ingestionController.getMonitoringSources);
router.post('/:source/backfill', ingestionController.runSourceBackfill);
router.post('/:source/sync', ingestionController.runSourceSync);
router.post('/:source/alerts', ingestionController.ingestSourcePayload);
router.post('/:tool/run', ingestionController.ingestTool);

module.exports = router;
