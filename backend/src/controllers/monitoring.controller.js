const monitoringService = require('../services/monitoring.service');

async function listTools(request, response, next) {
  try {
    const data = await monitoringService.listTools();

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function listApplications(request, response, next) {
  try {
    const data = await monitoringService.listApplications(request.params.tool);

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDetails(request, response, next) {
  try {
    const data = await monitoringService.getDetails(request.params.tool, request.params.entityId, {
      from: request.query.from,
      to: request.query.to,
    });

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDetails,
  listApplications,
  listTools,
};
