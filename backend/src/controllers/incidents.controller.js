const alertService = require('../services/alert.service');
const jiraIncidentMetricsService = require('../services/jiraIncidentMetrics.service');

async function getIncidents(request, response, next) {
  try {
    const incidents = await jiraIncidentMetricsService.listIncidents(request.query);
    response.json({ data: incidents });
  } catch (error) {
    next(error);
  }
}

async function getSummary(request, response, next) {
  try {
    const summary = await jiraIncidentMetricsService.getSummary(request.query);
    response.json({ data: summary });
  } catch (error) {
    next(error);
  }
}

async function getDailyCounts(request, response, next) {
  try {
    const dailyCounts = await jiraIncidentMetricsService.getDailyCounts(request.query);
    response.json({ data: dailyCounts });
  } catch (error) {
    next(error);
  }
}

async function getIncidentByKey(request, response, next) {
  try {
    const incident = await alertService.getIncidentByKey(request.params.key);

    if (!incident) {
      response.status(404).json({
        error: 'Not Found',
        message: `Incident ${request.params.key} was not found.`,
      });
      return;
    }

    response.json({ data: incident });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDailyCounts,
  getIncidentByKey,
  getIncidents,
  getSummary,
};
