const thousandEyesService = require('../services/thousandEyes.service');
const { workspaceService } = require('../services/thousandEyesWorkspace.service');

async function getWorkspaceDashboard(request, response, next) {
  try {
    response.json({ data: await workspaceService.getDashboard(request.query) });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceTest(request, response, next) {
  try {
    response.json({ data: await workspaceService.getTest(request.params.id, request.query) });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceAgent(request, response, next) {
  try {
    response.json({ data: await workspaceService.getAgent(request.params.id, request.query) });
  } catch (error) {
    next(error);
  }
}

async function listWorkspaceEvents(request, response, next) {
  try {
    response.json({ data: await workspaceService.getEvents(request.query) });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceEvent(request, response, next) {
  try {
    response.json({ data: await workspaceService.getEvent(request.params.id) });
  } catch (error) {
    next(error);
  }
}

async function listWorkspaceAlerts(request, response, next) {
  try {
    response.json({ data: await workspaceService.getAlerts(request.query) });
  } catch (error) {
    next(error);
  }
}

async function getWorkspaceAlert(request, response, next) {
  try {
    response.json({ data: await workspaceService.getAlert(request.params.id, request.query) });
  } catch (error) {
    next(error);
  }
}

async function listAlerts(request, response, next) {
  try {
    const result = await thousandEyesService.fetchAlerts({
      from: request.query.from,
      to: request.query.to,
      status: request.query.status,
    });

    response.json({
      data: {
        alerts: result.items,
        pagesFetched: result.pages,
        responseTimeMs: result.responseTimeMs,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getAlert(request, response, next) {
  try {
    const result = await thousandEyesService.fetchAlerts({
      alertId: request.params.id,
    });

    response.json({
      data: result.items[0] || null,
    });
  } catch (error) {
    next(error);
  }
}

async function listTests(request, response, next) {
  try {
    const result = await thousandEyesService.fetchTests({
      type: request.query.type,
    });

    response.json({
      data: {
        tests: result.items,
        pagesFetched: result.pages,
        responseTimeMs: result.responseTimeMs,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getTestResults(request, response, next) {
  try {
    const result = await thousandEyesService.fetchTestResults(request.params.id, {
      testType: request.query.type,
      from: request.query.from,
      to: request.query.to,
    });

    response.json({
      data: {
        results: result.items,
        responseTimeMs: result.responseTimeMs,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function sync(request, response, next) {
  try {
    const result = await thousandEyesService.syncThousandEyesData({
      from: request.body?.from,
      to: request.body?.to,
      status: request.body?.status,
      includeMetrics: request.body?.includeMetrics,
    });

    response.json({ data: result });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAlert,
  getTestResults,
  getWorkspaceAgent,
  getWorkspaceAlert,
  getWorkspaceDashboard,
  getWorkspaceEvent,
  getWorkspaceTest,
  listAlerts,
  listTests,
  listWorkspaceAlerts,
  listWorkspaceEvents,
  sync,
};
