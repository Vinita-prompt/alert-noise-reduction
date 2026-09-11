const abcHubService = require('../services/abcHub.service');

function buildOptions(request) {
  return {
    from: request.query.from,
    to: request.query.to,
  };
}

async function getDaemonMonitor(request, response, next) {
  try {
    const data = await abcHubService.getDaemonMonitor(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDaemonHistory(request, response, next) {
  try {
    const data = await abcHubService.getDaemonHistory(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function importDaemonMonitor(request, response, next) {
  try {
    const data = await abcHubService.importDaemonMonitorPayload(request.body);

    response.status(201).json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDataTrakUserMonitoring(request, response, next) {
  try {
    const data = await abcHubService.getDataTrakUserMonitoring(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDataTrakUserDetails(request, response, next) {
  try {
    const data = await abcHubService.getDataTrakUserDetails(request.params.id, buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

async function getDataTrakUserHistory(request, response, next) {
  try {
    const data = await abcHubService.getDataTrakUserHistory(buildOptions(request));

    response.json({ data });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDataTrakUserDetails,
  getDataTrakUserHistory,
  getDataTrakUserMonitoring,
  getDaemonHistory,
  getDaemonMonitor,
  importDaemonMonitor,
};
