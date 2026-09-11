const express = require('express');
const oracleApexController = require('../controllers/oracleApex.controller');

const router = express.Router();

router.post('/import', oracleApexController.importPayload);
router.post('/import/payload', oracleApexController.importPayload);
router.get('/applications', oracleApexController.listApplications);
router.get('/dashboard', oracleApexController.getDashboard);

module.exports = router;
