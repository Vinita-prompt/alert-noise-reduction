const express = require('express');
const incidentsController = require('../controllers/incidents.controller');

const router = express.Router();

router.get('/summary', incidentsController.getSummary);
router.get('/daily-counts', incidentsController.getDailyCounts);
router.get('/', incidentsController.getIncidents);
router.get('/:key', incidentsController.getIncidentByKey);

module.exports = router;
