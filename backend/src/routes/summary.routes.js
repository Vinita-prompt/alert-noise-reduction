const express = require('express');
const slackAlertStoreService = require('../services/slackAlertStore.service');
const { service: authenticationService } = require('../services/authentication.service');

const router = express.Router();

router.get('/', authenticationService.requireAuthenticated, async (request, response, next) => {
  try {
    response.json({
      success: true,
      data: await slackAlertStoreService.getOperationalOverview(request.query),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
