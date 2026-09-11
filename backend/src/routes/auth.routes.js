const express = require('express');
const { service: authenticationService } = require('../services/authentication.service');

function createAuthRouter(service = authenticationService) {
  const router = express.Router();

  router.get('/me', (request, response, next) => {
    try {
      response.json({ success: true, data: service.getCurrentUser(request) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (request, response, next) => {
    try {
      response.json({ success: true, data: await service.login(request, response) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/signup', async (request, response, next) => {
    try {
      response.status(201).json({ success: true, data: await service.signup(request) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', service.requireAuthenticated, service.requireCsrf, (request, response, next) => {
    try {
      response.json({ success: true, data: service.logout(request, response) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createAuthRouter();
module.exports.createAuthRouter = createAuthRouter;
