const express = require('express');
const { service } = require('../services/productObservability.service');
const { service: authenticationService } = require('../services/authentication.service');

const router = express.Router();
router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
router.get('/sources', authenticationService.requireAuthenticated, async (_request, response, next) => {
  try { response.json({ success: true, data: await service.monitoringSources() }); } catch (error) { next(error); }
});
router.get('/diagnostics', authenticationService.requireAdministrator, async (_request, response, next) => {
  try { response.json({ success: true, data: await service.diagnostics() }); } catch (error) { next(error); }
});
router.get('/daily', authenticationService.requireAdministrator, async (_request, response, next) => {
  try { response.json({ success: true, data: await service.daily() }); } catch (error) { next(error); }
});

module.exports = router;
